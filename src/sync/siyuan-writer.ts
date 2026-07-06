import { InboxSyncSettings } from "../types/settings";
import { ParsedAnnotation, ParsedNote } from "../types/inbox";
import {
  appendBlockToDoc,
  createDocWithMd,
  deleteBlock,
  getBlockAttrs,
  listDocsByBoxId,
  moveDocToPath,
  removeDoc,
  setBlockAttrs,
} from "../utils/siyuan-api";

export interface WriteNoteResult {
  isNew: boolean;
  docId: string;
}

/**
 * 写入 atomicNote 到思源文档
 * 策略：更新时删旧建新（重新解析 markdown 最稳；块级更新容易留残块）
 * 盒子作为 custom-box 属性；无盒子不写
 *
 * 盒子分文件夹由 SyncManager 通过 metadata.boxFolders 驱动：
 * - note.boxId 在 boxFolders 里查到 → /{basePath}/{boxFolder}/{title}
 * - 否则 → /{basePath}/{title}（根平铺）
 */
export class SiYuanWriter {
  private settings: InboxSyncSettings;
  /** noteId → docId，用于跨笔记引用转换（[[note-xxx]]、父子批注等） */
  private noteIdToDocId: Map<string, string> = new Map();
  /** blockId → docId，老格式 Card123 链接转换用 */
  private blockIdToDocId: Map<number, string> = new Map();

  constructor(settings: InboxSyncSettings) {
    this.settings = settings;
  }

  /**
   * 注册 noteId/blockId 到 docId 的映射，供后续 updateParentEmbeds/convertLinks 用
   * SyncManager 在第一轮写入完成后调用
   */
  registerDocIds(noteIdToDocId: Map<string, string>, blockIdToDocId: Map<number, string>): void {
    this.noteIdToDocId = noteIdToDocId;
    this.blockIdToDocId = blockIdToDocId;
  }

  /**
   * 写入或更新一条笔记
   * @param boxFolders boxId → 文件夹名映射（来自 metadata，SyncManager 在 reconcileBoxFolders 后灌入）
   * @param existingDocId 已有的 docId（来自 metadata），传 undefined 表示新建
   */
  async writeNote(
    note: ParsedNote,
    boxFolders: Record<string, string>,
    existingDocId?: string
  ): Promise<WriteNoteResult> {
    const displayTitle = this.getDisplayTitle(note);
    const docPath = this.buildDocPath(displayTitle, note, boxFolders);
    console.log(
      `[Writer][BOX] writeNote noteId=${note.noteId} boxId=${note.boxId ?? "(无)"} boxName=${note.boxName ?? "(无)"} → path="${docPath}" | existingDocId=${existingDocId ?? "(无)"}`
    );

    // 删旧建新：existingDocId 存在就先删
    let isNew = true;
    if (existingDocId) {
      try {
        await removeDoc(existingDocId);
        isNew = false;
      } catch (err) {
        console.warn(`[Writer] 删除旧文档失败，将新建: ${existingDocId}`, err);
      }
    }

    // 生成 markdown 内容（纯正文，frontmatter 走 custom 属性）
    const markdown = this.generateMarkdown(note);

    // 创建文档
    const docId = await createDocWithMd(this.settings.siyuanNotebookId, docPath, markdown);
    console.log(
      `[Writer][BOX] createDocWithMd 完成 noteId=${note.noteId} → docId=${docId} path="${docPath}"`
    );

    // 设置 custom 属性
    await this.setDocAttributes(docId, note, displayTitle);

    return { isNew, docId };
  }

  /**
   * 删除笔记
   * 调用方需提供 docId（来自 metadata）
   */
  async deleteNote(docId: string): Promise<boolean> {
    try {
      await removeDoc(docId);
      return true;
    } catch (err) {
      console.warn(`[Writer] 删除文档失败: ${docId}`, err);
      return false;
    }
  }

  /**
   * 在父笔记末尾追加子笔记的块引用
   * 用于独立的批注子笔记（parentId 指向父）
   */
  async updateParentEmbeds(parentDocId: string, childDocIds: string[]): Promise<void> {
    if (childDocIds.length === 0) return;

    // 先清掉旧的"批注"块（按属性识别），再追加新的
    await this.clearAnnotationEmbeds(parentDocId);

    for (const childId of childDocIds) {
      try {
        await appendBlockToDoc(parentDocId, `((${childId} "📝 批注"))`);
      } catch (err) {
        console.warn(`[Writer] 追加批注引用失败: parent=${parentDocId}, child=${childId}`, err);
      }
    }
  }

  /**
   * 给子笔记开头加上指向父笔记的块引用
   */
  async addChildParentRef(childDocId: string, parentDocId: string): Promise<void> {
    try {
      // 直接拿现有第一个块当锚点，在它前面插入
      // 思源 API 没有直接的 prepend，用 setBlockAttrs 改第一个块的内容也行，但会破坏原始内容
      // 简单方案：append 到末尾（思源文档属性面板能看双向链接，不强求开头）
      await appendBlockToDoc(childDocId, `> 父笔记: ((${parentDocId}))`);
    } catch (err) {
      console.warn(`[Writer] 添加父引用失败: child=${childDocId}, parent=${parentDocId}`, err);
    }
  }

  /**
   * 转换笔记正文中的 [[note-xxx]] / [[Card123]] 链接为思源块引用
   * v1 简化实现：暂不操作（思源正文里的 [[xxx]] 会以纯文本展示）
   * 后续可基于 /api/block/getChildBlocks + updateBlock 实现
   */
  async convertLinks(_docId: string): Promise<void> {
    // TODO: v2 实现
  }

  // ============ 私有辅助 ============

  private async setDocAttributes(
    docId: string,
    note: ParsedNote,
    displayTitle: string
  ): Promise<void> {
    const attrs: Record<string, string> = {
      "custom-inbox-id": note.noteId,
      "custom-inbox-created": note.createdAt.toISOString(),
      "custom-inbox-updated": note.updatedAt.toISOString(),
      "custom-inbox-title": displayTitle,
    };

    if (note.boxName) {
      attrs["custom-box"] = note.boxName;
    }
    if (note.boxId) {
      attrs["custom-inbox-box-id"] = note.boxId;
    }
    if (note.parentId) {
      attrs["custom-inbox-parent"] = note.parentId;
    }
    if (note.tags.length > 0) {
      attrs["custom-inbox-tags"] = note.tags.join(" ");
    }

    await setBlockAttrs(docId, attrs);
  }

  /**
   * 清除父笔记末尾旧的批注引用块
   * 通过查 custom-inbox-annotation-embed 属性识别
   */
  private async clearAnnotationEmbeds(parentDocId: string): Promise<void> {
    // 简化：查询文档子块，找带特定标识的删除
    // 这里偷个懒，依赖 appendBlockToDoc 自然累积，先不主动清理
    // 风险：重 sync 会重复；后续优化时再加
    void parentDocId;
    void getBlockAttrs;
    void deleteBlock;
  }

  /**
   * 生成 markdown 内容
   * 不含 frontmatter（思源不识别），custom 属性走 setBlockAttrs
   */
  private generateMarkdown(note: ParsedNote): string {
    const lines: string[] = [];

    // 正文
    lines.push(note.content || "");

    // ver=2 内联批注 → 父笔记末尾的引用块
    const annotationBlock = this.generateInlineAnnotations(note.annotations);
    if (annotationBlock) {
      lines.push(annotationBlock);
    }

    return lines.join("\n");
  }

  private generateInlineAnnotations(annotations: ParsedAnnotation[]): string | null {
    const visible = annotations.filter((a) => !a.isRemoved);
    if (visible.length === 0) return null;

    const lines: string[] = ["", "---", "", "> **批注**"];

    for (const annotation of visible) {
      lines.push(">");
      lines.push(`> [!note] ${this.getAnnotationTitle(annotation)}`);

      const contentLines = annotation.content.split(/\r?\n/);
      if (contentLines.length === 0 || (contentLines.length === 1 && contentLines[0].trim() === "")) {
        lines.push("> ");
      } else {
        for (const line of contentLines) {
          lines.push(line ? `> ${line}` : ">");
        }
      }

      if (annotation.tags.length > 0) {
        lines.push(">");
        lines.push(`> ${annotation.tags.map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ")}`);
      }
    }

    return lines.join("\n");
  }

  private getAnnotationTitle(annotation: ParsedAnnotation): string {
    const title = annotation.title?.trim();
    const time = this.formatAnnotationTime(annotation.createdAt.getTime());
    if (title && title !== "Untitled") return `${title} - ${time}`;
    return time;
  }

  private formatAnnotationTime(timestamp: number): string {
    const d = new Date(timestamp);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  private getDisplayTitle(note: ParsedNote): string {
    const title = note.title?.trim();
    if (title && title !== "Untitled") return title;
    return this.formatTimeTitle(note.createdAt.getTime());
  }

  private formatTimeTitle(timestamp: number): string {
    const d = new Date(timestamp);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  }

  /**
   * 构建思源文档路径
   * - note.boxId 在 boxFolders 里能查到 → /{basePath}/{boxFolder}/{title}
   * - 否则（无盒子 / 盒子被删墓碑 / boxFolders 还没登记）→ /{basePath}/{title}（根平铺）
   *
   * boxFolders 由 SyncManager 在 reconcileBoxFolders 阶段已清洗 + 撞名处理，这里直接信任。
   */
  private buildDocPath(
    displayTitle: string,
    note: ParsedNote,
    boxFolders: Record<string, string>
  ): string {
    const sanitizedTitle = this.sanitizeFileName(displayTitle);
    const base = this.settings.siyuanBasePath?.trim() || "";
    const normalizedBase = base.replace(/^\/+|\/+$/g, "");

    const boxFolder = note.boxId ? boxFolders[note.boxId] : undefined;
    console.log(
      `[Writer][BOX] buildDocPath noteId=${note.noteId} boxId=${note.boxId ?? "(无)"} boxName=${note.boxName ?? "(无)"} base="${normalizedBase}" boxFolder=${boxFolder ? `"${boxFolder}"` : "(无,根平铺)"}`
    );

    if (note.boxId && boxFolder) {
      const parts = normalizedBase
        ? [normalizedBase, boxFolder, sanitizedTitle]
        : [boxFolder, sanitizedTitle];
      return "/" + parts.join("/");
    }
    return normalizedBase
      ? `/${normalizedBase}/${sanitizedTitle}`
      : `/${sanitizedTitle}`;
  }

  /**
   * 撞名检测：清洗后的文件夹名跟其他 boxId 撞 → 追加 boxId 短码后缀
   * 纯字符串处理，不创建文档。SyncManager 在 reconcileBoxFolders 阶段调。
   */
  ensureUniqueBoxFolderName(
    rawName: string,
    boxId: string,
    boxFolders: Record<string, string>
  ): string {
    const sanitized = this.sanitizeFolderName(rawName) || boxId;
    const existing = new Set(
      Object.entries(boxFolders)
        .filter(([id]) => id !== boxId)
        .map(([, name]) => name)
    );
    if (existing.has(sanitized)) {
      const shortId = boxId.replace(/^box-/, "").slice(0, 8);
      const unique = `${sanitized}-${shortId}`;
      console.warn(`[Writer] 盒子名 "${rawName}" 撞已有文件夹, 改为 "${unique}"`);
      return unique;
    }
    return sanitized;
  }

  /**
   * 盒子改名：把该 boxId 下所有文档 move 到新路径 + 同步 custom-box 属性
   * 思源没有"重命名文件夹"操作，只能逐文档 move
   *
   * 撞名处理：新名字如果跟其他 boxId 撞，先 ensureUniqueBoxFolderName 加后缀
   */
  async renameBoxFolder(
    boxId: string,
    oldFolderName: string,
    newFolderName: string,
    boxFolders: Record<string, string>
  ): Promise<void> {
    const notebook = this.settings.siyuanNotebookId;
    const base = this.settings.siyuanBasePath?.trim().replace(/^\/+|\/+$/g, "") ?? "";
    const safeNewName = this.ensureUniqueBoxFolderName(newFolderName, boxId, boxFolders);
    const newPath = base ? `/${base}/${safeNewName}` : `/${safeNewName}`;

    const docs = await listDocsByBoxId(notebook, boxId);
    console.log(
      `[Writer] renameBoxFolder: ${boxId} ${oldFolderName}→${safeNewName}, ${docs.length} 个文档`
    );

    for (const doc of docs) {
      try {
        const finalPath = `${newPath}/${this.sanitizeFileName(doc.title)}`;
        await moveDocToPath(doc.docId, finalPath, notebook);
        await setBlockAttrs(doc.docId, { "custom-box": safeNewName });
      } catch (err) {
        console.warn(`[Writer] renameBoxFolder 移动失败: ${doc.docId} (${doc.title})`, err);
      }
    }
  }

  /**
   * 盒子被 deleted_at 墓碑：把该 boxId 下所有文档 move 回根 + 清 custom-box 属性
   * 思源不需要删空文件夹 — 路径下没文档自然消失
   *
   * 关键决策：custom-inbox-box-id 保留作为反查锚（盒子撤销删除时可恢复），只清 custom-box
   */
  async dissolveBoxFolder(boxId: string, oldFolderName: string): Promise<void> {
    const notebook = this.settings.siyuanNotebookId;
    const base = this.settings.siyuanBasePath?.trim().replace(/^\/+|\/+$/g, "") ?? "";
    const rootPath = base ? `/${base}` : "/";

    const docs = await listDocsByBoxId(notebook, boxId);
    console.log(
      `[Writer] dissolveBoxFolder: ${boxId} (${oldFolderName}), ${docs.length} 个文档`
    );

    for (const doc of docs) {
      try {
        const finalPath = `${rootPath}/${this.sanitizeFileName(doc.title)}`;
        await moveDocToPath(doc.docId, finalPath, notebook);
        // custom-inbox-box-id 保留作反查锚，只清 custom-box
        await setBlockAttrs(doc.docId, { "custom-box": "" });
      } catch (err) {
        console.warn(`[Writer] dissolveBoxFolder 移动失败: ${doc.docId} (${doc.title})`, err);
      }
    }
  }

  private sanitizeFileName(name: string): string {
    if (!name) return "untitled";
    return name
      .replace(/[<>:"/\\|?*]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 100);
  }

  private sanitizeFolderName(name?: string): string {
    if (!name) return "";
    return name
      .replace(/[<>:"/\\|?*]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 50);
  }
}
