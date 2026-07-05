import { SyncMetadata } from "../types/inbox";

/**
 * 思源插件存储适配器
 * 实际由 Plugin 实例提供（plugin.loadData / plugin.saveData）
 */
export interface PluginStorage {
  loadData(name: string): Promise<unknown>;
  saveData(name: string, data: unknown): Promise<unknown>;
}

const META_FILE = "sync-meta.json";

/**
 * 同步元数据存储
 * 比 obsidian 版多了 docId 字段（思源文档 ID，用于更新/删除时定位）
 */
export class MetadataStorage {
  constructor(private storage: PluginStorage) {}

  async load(): Promise<SyncMetadata> {
    try {
      const data = (await this.storage.loadData(META_FILE)) as Record<string, unknown> | null;
      if (data && this.isValid(data)) {
        return data as unknown as SyncMetadata;
      }
    } catch (err) {
      console.warn("[Meta] 加载元数据失败:", err);
    }
    return this.createDefault();
  }

  async save(metadata: SyncMetadata): Promise<void> {
    await this.storage.saveData(META_FILE, metadata);
  }

  async clear(): Promise<void> {
    await this.save(this.createDefault());
  }

  private createDefault(): SyncMetadata {
    return { lastSyncTime: 0, lastSyncMeta: {}, version: "2.0.0" };
  }

  private isValid(data: Record<string, unknown>): boolean {
    return (
      typeof data.lastSyncTime === "number" &&
      typeof data.lastSyncMeta === "object" &&
      data.lastSyncMeta !== null &&
      typeof data.version === "string"
    );
  }
}
