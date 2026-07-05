import { InboxSyncSettings } from "../types/settings";
import { CloudClient } from "./cloud-client";
import { ParsedAsset, ParsedNote } from "../types/inbox";
import { putFile } from "../utils/siyuan-api";

export interface AssetStats {
  total: number;
  downloaded: number;
  skipped: number;
  failed: number;
}

const SIYUAN_DATA_PREFIX = "/data/assets/inbox-sync";
const SIYUAN_MD_PREFIX = "assets/inbox-sync";

/**
 * 资源处理：从云端下载，写到思源 data/assets/inbox-sync/ 下
 * v1 不做跨会话存在性检查（每次新同步会重传）— 内存级去重保证同一会话不重复
 */
export class AssetHandler {
  private settings: InboxSyncSettings;
  private cloudClient: CloudClient;
  private processedAssets: Set<string> = new Set();

  constructor(settings: InboxSyncSettings, cloudClient: CloudClient) {
    this.settings = settings;
    this.cloudClient = cloudClient;
  }

  async handleAssets(note: ParsedNote): Promise<AssetStats> {
    const stats: AssetStats = { total: 0, downloaded: 0, skipped: 0, failed: 0 };

    const allAssets: ParsedAsset[] = [
      ...note.images,
      ...note.videos,
      ...note.audios,
      ...note.attachments,
      ...note.annotations.flatMap((a) => a.assets),
    ];
    stats.total = allAssets.length;

    for (const asset of allAssets) {
      try {
        const downloaded = await this.downloadAsset(asset);
        if (downloaded) stats.downloaded++;
        else stats.skipped++;
      } catch (err) {
        stats.failed++;
        console.error(`[Asset] 下载失败: ${asset.remoteUrl}`, err);
      }
    }
    return stats;
  }

  private async downloadAsset(asset: ParsedAsset): Promise<boolean> {
    if (!asset.remoteUrl && !asset.remotePath) return false;
    if (asset.remotePath && asset.remotePath.startsWith("unknown-")) return false;

    const localPath = this.getAssetLocalPath(asset);

    // 内存去重
    if (this.processedAssets.has(localPath)) return false;
    this.processedAssets.add(localPath);

    const downloadPath = asset.remoteUrl && asset.remoteUrl.startsWith("http")
      ? asset.remoteUrl
      : asset.remotePath;

    const buffer = await this.cloudClient.downloadAsset(downloadPath);
    if (!buffer) {
      throw new Error(`下载失败: ${downloadPath}`);
    }

    // 上传到思源 data/ 下
    await putFile(localPath, buffer);
    return true;
  }

  /**
   * 把 ParsedAsset.localPath（如 "assets/images/foo.png"）
   * 重映射到思源 data/ 下完整路径（如 "/data/assets/inbox-sync/images/foo.png"）
   */
  private getAssetLocalPath(asset: ParsedAsset): string {
    // localPath 形如 "assets/images/xxx.png"，剥离开头的 "assets/"
    const suffix = asset.localPath.replace(/^assets?\//, "");
    return `${SIYUAN_DATA_PREFIX}/${suffix}`;
  }

  /**
   * 给 markdown 用的引用路径（如 "assets/inbox-sync/images/foo.png"）
   * 后续若需要回写 markdown 用
   */
  static getMarkdownPath(asset: ParsedAsset): string {
    const suffix = asset.localPath.replace(/^assets?\//, "");
    return `${SIYUAN_MD_PREFIX}/${suffix}`;
  }

  resetProcessedAssets(): void {
    this.processedAssets.clear();
  }
}
