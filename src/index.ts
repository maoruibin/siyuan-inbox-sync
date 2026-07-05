import { Plugin, showMessage } from "siyuan";
import { InboxSyncSettings, DEFAULT_SETTINGS } from "./types/settings";
import { SyncManager } from "./sync/sync-manager";
import { MetadataStorage } from "./storage/metadata-storage";
import { openSettingsDialog } from "./ui/settings-dialog";
import { listNotebooks } from "./utils/siyuan-api";

const SETTINGS_FILE = "settings.json";

export default class InboxSyncPlugin extends Plugin {
  settings: InboxSyncSettings = DEFAULT_SETTINGS;
  syncManager: SyncManager | null = null;
  private metadataStorage: MetadataStorage | null = null;
  private autoSyncTimer: number | null = null;
  private isSyncing = false;

  async onload(): Promise<void> {
    console.debug("[inBox Sync] loading...");

    try {
      const data = (await this.loadData(SETTINGS_FILE)) as Partial<InboxSyncSettings> | null;
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
    } catch (err) {
      console.warn("[inBox Sync] 加载设置失败，用默认值:", err);
    }

    this.metadataStorage = new MetadataStorage({
      loadData: (name: string) => this.loadData(name),
      saveData: (name: string, d: unknown) => this.saveData(name, d),
    });
    this.syncManager = new SyncManager(this.settings, this.metadataStorage);

    this.startAutoSyncIfNeeded();

    this.addTopBar({
      icon: "iconRefresh",
      title: "inBox 同步",
      position: "right",
      callback: () => {
        void this.syncNow();
      },
    });
  }

  onunload(): void {
    console.debug("[inBox Sync] unloading");
    this.stopAutoSync();
  }

  /**
   * 打开设置面板（思源调用）
   */
  openSetting(): void {
    void openSettingsDialog(this);
  }

  async updateSettings(next: Partial<InboxSyncSettings>): Promise<void> {
    this.settings = Object.assign({}, this.settings, next);
    await this.saveData(SETTINGS_FILE, this.settings);
    this.syncManager?.updateSettings(this.settings);
    this.startAutoSyncIfNeeded();
  }

  /**
   * 立即同步
   */
  async syncNow(): Promise<void> {
    if (!this.validateSettings()) return;
    if (this.isSyncing) {
      showMessage("正在同步中...", 2000, "info");
      return;
    }
    if (!this.syncManager) {
      showMessage("插件尚未初始化完成", 3000, "error");
      return;
    }

    this.isSyncing = true;
    showMessage("开始从 inBox 同步...", 0, "info");

    try {
      const stats = await this.syncManager.sync((msg) => {
        showMessage(msg, 0, "info");
      });

      if (stats.failedNotes === 0 && stats.failedAssets === 0) {
        showMessage(
          `同步完成：新增 ${stats.newNotes}, 更新 ${stats.updatedNotes}, 删除 ${stats.deletedNotes}, 跳过 ${stats.skippedNotes}`,
          5000,
          "info"
        );
      } else {
        showMessage(
          `同步结束（有错误）：失败笔记 ${stats.failedNotes}, 失败资源 ${stats.failedAssets}`,
          10_000,
          "error"
        );
        console.error("[inBox Sync] errors:", stats.errors);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showMessage(`同步失败：${msg}`, 10_000, "error");
      console.error("[inBox Sync] failed:", err);
    } finally {
      this.isSyncing = false;
    }
  }

  // ============ 私有 ============

  private validateSettings(): boolean {
    if (this.settings.storageType === "webdav") {
      if (!this.settings.webdavUrl || !this.settings.webdavUsername || !this.settings.webdavPassword) {
        showMessage("请先在设置中完成 WebDAV 配置", 3000, "error");
        return false;
      }
    } else {
      if (!this.settings.s3Endpoint || !this.settings.s3AccessKey || !this.settings.s3SecretKey || !this.settings.s3Bucket) {
        showMessage("请先在设置中完成 S3 配置", 3000, "error");
        return false;
      }
    }
    if (!this.settings.siyuanNotebookId) {
      showMessage("请先在设置中选择目标笔记本", 3000, "error");
      return false;
    }
    return true;
  }

  private startAutoSyncIfNeeded(): void {
    this.stopAutoSync();
    if (!this.settings.enableAutoSync || this.settings.syncInterval <= 0) return;
    const ms = this.settings.syncInterval * 60 * 1000;
    this.autoSyncTimer = window.setInterval(() => {
      void this.syncNow();
    }, ms);
  }

  private stopAutoSync(): void {
    if (this.autoSyncTimer !== null) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }
}

/**
 * 给 settings-dialog.ts 用：拉笔记本清单
 */
export async function fetchNotebooks(): Promise<{ id: string; name: string }[]> {
  return listNotebooks().then((list) => list.map((nb) => ({ id: nb.id, name: nb.name })));
}
