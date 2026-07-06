import { InboxSyncSettings, getCloudRootPath } from "../types/settings";
import { CloudClient, CloudFileInfo } from "./cloud-client";
import { WebDAVClient } from "./webdav-client";
import { S3Client } from "./s3-client";
import { NoteParser } from "./note-parser";
import { SiYuanWriter } from "./siyuan-writer";
import { AssetHandler } from "./asset-handler";
import { MetadataStorage } from "../storage/metadata-storage";
import {
  AtomicNote,
  ParsedNote,
  SyncMetadata,
  SyncStats,
} from "../types/inbox";

export type SyncNotify = (message: string) => void;

/**
 * 同步协调器（单向：云端 → 思源）
 * 增量策略（参考 Android ThinkPlus）：
 * 1. listNotes() 拿云端 ETag/MTime 元数据，不下载内容
 * 2. 对比 metadata → ETag 相同则跳过
 * 3. 只下载有变化的
 * 4. 检测云端删除（本地有但云端无）
 */
export class SyncManager {
  private settings: InboxSyncSettings;
  private cloudClient!: CloudClient;
  private noteParser: NoteParser;
  private writer: SiYuanWriter;
  private assetHandler: AssetHandler;
  private metadataStorage: MetadataStorage;
  private abortController: AbortController | null = null;

  constructor(settings: InboxSyncSettings, storage: MetadataStorage) {
    this.settings = settings;
    this.metadataStorage = storage;
    this.initializeClients();
    this.noteParser = new NoteParser();
    this.writer = new SiYuanWriter(settings);
    this.assetHandler = new AssetHandler(settings, this.cloudClient);
  }

  private initializeClients(): void {
    const rootPath = getCloudRootPath(this.settings);
    if (this.settings.storageType === "webdav") {
      this.cloudClient = new WebDAVClient(
        this.settings.webdavUrl,
        this.settings.webdavUsername,
        this.settings.webdavPassword,
        rootPath
      );
    } else {
      this.cloudClient = new S3Client(
        this.settings.s3Endpoint,
        this.settings.s3AccessKey,
        this.settings.s3SecretKey,
        this.settings.s3Bucket,
        this.settings.s3Region,
        rootPath
      );
    }
  }

  updateSettings(settings: InboxSyncSettings): void {
    this.settings = settings;
    this.initializeClients();
    this.writer = new SiYuanWriter(settings);
    this.assetHandler = new AssetHandler(settings, this.cloudClient);
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    return this.cloudClient.testConnection();
  }

  async sync(notify?: SyncNotify): Promise<SyncStats> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const stats: SyncStats = {
      totalNotes: 0,
      newNotes: 0,
      updatedNotes: 0,
      skippedNotes: 0,
      deletedNotes: 0,
      failedNotes: 0,
      totalAssets: 0,
      downloadedAssets: 0,
      skippedAssets: 0,
      failedAssets: 0,
      startTime: Date.now(),
      endTime: 0,
      errors: [],
    };

    try {
      console.log("[Sync] === sync() 被调用，开始同步流程 ===");
      notify?.("开始同步...");

      // 1. 加载本地 metadata
      const metadata = await this.metadataStorage.load();

      // 2. 拉 boxes.json 构建 boxId → name
      const boxNameMap = await this.buildBoxNameMap();
      this.noteParser.setBoxNameMap(boxNameMap);
      console.log(
        `[Sync][BOX] 注入 parser 的 boxNameMap (${boxNameMap.size} 个):`,
        Array.from(boxNameMap.entries()).map(([id, name]) => `${id}=${name}`)
      );

      // 2.5 对账盒子文件夹（rename / dissolve / 新增登记），失败不阻断主同步
      console.log(
        `[Sync][BOX] 对账前 metadata.boxFolders:`,
        metadata.boxFolders ? JSON.stringify(metadata.boxFolders) : "(空)"
      );
      try {
        await this.reconcileBoxFolders(metadata, boxNameMap, notify);
        console.log(
          `[Sync][BOX] 对账后 metadata.boxFolders:`,
          JSON.stringify(metadata.boxFolders)
        );
      } catch (err) {
        console.warn("[Sync][BOX] 盒子对账失败, 继续主流程:", err);
      }

      // 3. 列云端清单
      notify?.("扫描云端文件...");
      const cloudFiles = await this.cloudClient.listNotes();

      // 4. 增量对比
      const { toDownload, toDelete, unchanged } = this.diffCloudAndLocal(cloudFiles, metadata);
      console.log(`[Sync] 增量: 下载 ${toDownload.length}, 删除 ${toDelete.length}, 跳过 ${unchanged}`);

      // 5. 处理云端删除
      if (toDelete.length > 0) {
        notify?.(`处理云端删除 (${toDelete.length} 条)...`);
        for (const noteId of toDelete) {
          if (signal.aborted) throw new Error("同步已取消");
          const meta = metadata.lastSyncMeta[noteId];
          if (meta?.docId) {
            try {
              await this.writer.deleteNote(meta.docId);
            } catch (err) {
              console.warn(`[Sync] 删除文档失败: ${noteId}`, err);
            }
          }
          delete metadata.lastSyncMeta[noteId];
          stats.deletedNotes++;
        }
      }

      // 6. 下载有变化的笔记
      stats.totalNotes = toDownload.length + unchanged;
      const allNotes = new Map<string, AtomicNote>();
      if (toDownload.length > 0) {
        notify?.(`下载笔记 (${toDownload.length} 条)...`);
        await this.downloadChangedNotes(toDownload, allNotes, signal, notify);
      }

      // 7. 第一轮：解析 + 写入
      // noteId → docId（用于父子引用、链接转换）
      const noteIdToDocId = new Map<string, string>();
      const blockIdToDocId = new Map<number, string>();
      // parentId (noteId) → childDocIds
      const parentChildMap = new Map<string, string[]>();
      let processed = 0;

      for (const [noteId, atomicNote] of allNotes) {
        if (signal.aborted) throw new Error("同步已取消");
        try {
          notify?.(`处理笔记 ${++processed}/${allNotes.size}...`);
          const parsed = this.noteParser.parse(atomicNote);
          console.log(
            `[Sync][BOX] 第1轮 ${processed}/${allNotes.size} noteId=${noteId} boxId=${parsed.boxId ?? "(无)"} boxName=${parsed.boxName ?? "(无)"} isRemoved=${parsed.isRemoved} title=${JSON.stringify(parsed.title ?? "")}`
          );

          if (parsed.isRemoved) {
            const old = metadata.lastSyncMeta[noteId];
            if (old?.docId) {
              await this.writer.deleteNote(old.docId);
            }
            stats.deletedNotes++;
            delete metadata.lastSyncMeta[noteId];
            continue;
          }

          const existingDocId = metadata.lastSyncMeta[noteId]?.docId;
          const result = await this.writer.writeNote(parsed, metadata.boxFolders ?? {}, existingDocId);

          noteIdToDocId.set(parsed.noteId, result.docId);
          if (parsed.blockId) {
            blockIdToDocId.set(parsed.blockId, result.docId);
          }
          if (parsed.parentId) {
            const arr = parentChildMap.get(parsed.parentId) ?? [];
            arr.push(result.docId);
            parentChildMap.set(parsed.parentId, arr);
          }

          // 资源
          const assetStats = await this.assetHandler.handleAssets(parsed);
          stats.totalAssets += assetStats.total;
          stats.downloadedAssets += assetStats.downloaded;
          stats.skippedAssets += assetStats.skipped;
          stats.failedAssets += assetStats.failed;

          if (result.isNew) stats.newNotes++;
          else stats.updatedNotes++;

          // 更新 metadata（docId 即使是新建也要记录）
          metadata.lastSyncMeta[noteId] = {
            etag: cloudFiles.find((f) => f.id === noteId)?.etag || "",
            mtime: cloudFiles.find((f) => f.id === noteId)?.mtime || 0,
            docId: result.docId,
          };
        } catch (err) {
          stats.failedNotes++;
          const msg = `处理笔记 ${noteId} 失败: ${err instanceof Error ? err.message : String(err)}`;
          stats.errors.push(msg);
          console.error(msg);
        }
      }

      // 把映射注入 writer，给后续父子引用/链接转换用
      this.writer.registerDocIds(noteIdToDocId, blockIdToDocId);

      // 8. 第二轮：父子批注引用
      if (parentChildMap.size > 0) {
        notify?.("更新父子批注引用...");
        for (const [parentNoteId, childDocIds] of parentChildMap) {
          const parentDocId = noteIdToDocId.get(parentNoteId);
          if (!parentDocId) {
            console.warn(`[Sync] 父笔记未找到: ${parentNoteId}`);
            continue;
          }
          try {
            await this.writer.updateParentEmbeds(parentDocId, childDocIds);
            // 子笔记开头加父引用（可选，思源有双向链接面板，可省）
            // for (const childId of childDocIds) {
            //   await this.writer.addChildParentRef(childId, parentDocId);
            // }
          } catch (err) {
            console.warn(`[Sync] 更新父子引用失败: ${parentNoteId}`, err);
          }
        }
      }

      // 9. 第三轮：链接转换（v1 跳过）
      // for (const docId of noteIdToDocId.values()) {
      //   await this.writer.convertLinks(docId);
      // }

      // 10. 把所有云端文件元数据补全到 lastSyncMeta（包括跳过的）
      for (const file of cloudFiles) {
        if (!metadata.lastSyncMeta[file.id]) {
          metadata.lastSyncMeta[file.id] = {
            etag: file.etag || "",
            mtime: file.mtime || 0,
          };
        } else {
          metadata.lastSyncMeta[file.id].etag = file.etag || metadata.lastSyncMeta[file.id].etag;
          metadata.lastSyncMeta[file.id].mtime = file.mtime || metadata.lastSyncMeta[file.id].mtime;
        }
      }
      metadata.lastSyncTime = Date.now();
      await this.metadataStorage.save(metadata);

      const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
      notify?.(`同步完成！新增 ${stats.newNotes}, 更新 ${stats.updatedNotes}, 删除 ${stats.deletedNotes}, 跳过 ${unchanged} (${elapsed}s)`);
      console.log(`[Sync] 完成 (${elapsed}s) — 新增 ${stats.newNotes} 更新 ${stats.updatedNotes} 删除 ${stats.deletedNotes} 失败 ${stats.failedNotes}`);
    } catch (err) {
      if (signal.aborted) {
        notify?.("同步已取消");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        stats.errors.push(`同步错误: ${msg}`);
        console.error("[Sync] 同步错误:", err);
      }
    }

    stats.endTime = Date.now();
    this.abortController = null;
    return stats;
  }

  // ============ 私有 ============

  private diffCloudAndLocal(
    cloudFiles: CloudFileInfo[],
    metadata: SyncMetadata
  ): { toDownload: CloudFileInfo[]; toDelete: string[]; unchanged: number } {
    const toDownload: CloudFileInfo[] = [];
    const cloudIds = new Set<string>();

    for (const file of cloudFiles) {
      cloudIds.add(file.id);
      const local = metadata.lastSyncMeta[file.id];
      if (!local) {
        toDownload.push(file);
      } else if (local.etag && file.etag && local.etag === file.etag) {
        // 未变化
      } else if (local.mtime && file.mtime && file.mtime <= local.mtime) {
        // mtime 未更新
      } else {
        toDownload.push(file);
      }
    }

    const toDelete: string[] = [];
    for (const noteId of Object.keys(metadata.lastSyncMeta)) {
      if (!cloudIds.has(noteId)) toDelete.push(noteId);
    }

    return { toDownload, toDelete, unchanged: cloudFiles.length - toDownload.length };
  }

  private async downloadChangedNotes(
    files: CloudFileInfo[],
    sink: Map<string, AtomicNote>,
    signal: AbortSignal,
    notify?: SyncNotify
  ): Promise<void> {
    let ok = 0;
    let fail = 0;
    const total = files.length;
    const step = Math.max(10, Math.floor(total / 10));

    for (let i = 0; i < files.length; i++) {
      if (signal.aborted) throw new Error("同步已取消");
      const file = files[i];
      try {
        const note = await this.cloudClient.downloadAtomicNote(file.path);
        if (note) {
          sink.set(note.id, note);
          ok++;
        }
      } catch (err) {
        fail++;
        if (fail <= 5) console.warn(`[Sync] 下载失败: ${file.path}`, err);
      }

      const done = ok + fail;
      if (done % step === 0 || done === total) {
        const msg = `下载笔记 ${done}/${total} (成功 ${ok}, 失败 ${fail})`;
        notify?.(msg);
      }
    }
  }

  /**
   * 盒子文件夹对账：
   * - boxFolders 有，boxNameMap 没 → 盒子被删墓碑 → dissolveBoxFolder + 移回根
   * - 两边都有但 name 不同 → 盒子改名 → renameBoxFolder
   * - boxNameMap 有，boxFolders 没 → 新盒子 → 登记到 boxFolders（暂不建空文件夹）
   *
   * 调用方负责保存 metadata（boxFolders 在 metadata 上原地修改）。
   */
  private async reconcileBoxFolders(
    metadata: SyncMetadata,
    boxNameMap: Map<string, string>,
    notify?: SyncNotify
  ): Promise<void> {
    if (!metadata.boxFolders) metadata.boxFolders = {};
    const boxFolders = metadata.boxFolders;
    console.log(
      `[Sync][BOX] reconcile 开始: boxFolders keys=${Object.keys(boxFolders).length}, boxNameMap keys=${boxNameMap.size}`
    );

    // 1. rename + dissolve
    for (const boxId of Object.keys(boxFolders)) {
      const oldName = boxFolders[boxId];
      const newName = boxNameMap.get(boxId);

      if (!newName) {
        notify?.(`盒子 "${oldName}" 已删除, 移回根目录...`);
        console.log(`[Sync][BOX] 盒子 ${boxId} 已删除, dissolve ${oldName}`);
        try {
          await this.writer.dissolveBoxFolder(boxId, oldName);
          console.log(`[Sync][BOX] dissolve 成功: ${boxId} (${oldName})`);
        } catch (err) {
          console.warn(`[Sync][BOX] dissolve 失败 ${boxId}:`, err);
        }
        delete boxFolders[boxId];
        continue;
      }

      if (oldName !== newName) {
        notify?.(`盒子改名: ${oldName} → ${newName}...`);
        console.log(`[Sync][BOX] 盒子 ${boxId} 改名: ${oldName} → ${newName}`);
        try {
          await this.writer.renameBoxFolder(boxId, oldName, newName, boxFolders);
          boxFolders[boxId] = newName;
          console.log(`[Sync][BOX] rename 成功: ${boxId} → ${newName}`);
        } catch (err) {
          console.warn(`[Sync][BOX] rename 失败 ${boxId}:`, err);
        }
      } else {
        console.log(`[Sync][BOX] 盒子 ${boxId} 名称未变: ${oldName}`);
      }
    }

    // 2. 新增登记（不预先建空文件夹，等有笔记落到这个 boxId 时 writeNote 自然创建）
    console.log(
      `[Sync][BOX] 检查新增盒子: boxNameMap=${Array.from(boxNameMap.entries()).map(
        ([id, name]) => `${id}=${name}`
      )}, 已登记 boxFolders=${JSON.stringify(boxFolders)}`
    );
    for (const [boxId, name] of boxNameMap.entries()) {
      if (!boxFolders[boxId]) {
        boxFolders[boxId] = this.writer.ensureUniqueBoxFolderName(name, boxId, boxFolders);
        console.log(
          `[Sync][BOX] 新增盒子登记: ${boxId} → 文件夹名="${boxFolders[boxId]}" (原始名="${name}")`
        );
      } else {
        console.log(`[Sync][BOX] 盒子已登记, 跳过: ${boxId} → ${boxFolders[boxId]}`);
      }
    }
    console.log(`[Sync][BOX] reconcile 结束: 最终 boxFolders=${JSON.stringify(boxFolders)}`);
  }

  private async buildBoxNameMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const manifest = await this.cloudClient.downloadBoxesManifest();
      if (!manifest || !Array.isArray(manifest.boxes)) {
        console.warn(
          `[Sync][BOX] boxes.json 拉取异常: manifest=${manifest ? "存在但 boxes 非数组" : "null/undefined"}`
        );
        return map;
      }
      console.log(
        `[Sync][BOX] boxes.json 原始 ${manifest.boxes.length} 个:`,
        manifest.boxes.map((b) => ({
          box_id: b.box_id,
          name: b.name,
          deleted_at: b.deleted_at,
          include_in_home: b.include_in_home,
        }))
      );
      for (const box of manifest.boxes) {
        if (!box.box_id || !box.name) {
          console.warn(`[Sync][BOX] 跳过无效盒子项:`, box);
          continue;
        }
        if (box.deleted_at != null) {
          console.log(`[Sync][BOX] 跳过墓碑盒子: ${box.box_id} (${box.name}) deleted_at=${box.deleted_at}`);
          continue;
        }
        map.set(box.box_id, box.name);
      }
      console.log(
        `[Sync][BOX] 盒子清单有效 ${map.size} 个:`,
        Array.from(map.entries()).map(([id, name]) => `${id}=${name}`)
      );
    } catch (err) {
      console.warn("[Sync][BOX] 拉 boxes.json 失败:", err);
    }
    return map;
  }
}
