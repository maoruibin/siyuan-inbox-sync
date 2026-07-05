import { CloudClient, CloudFileInfo } from "./cloud-client";
import { AtomicNote, BoxesManifest, SyncManifest } from "../types/inbox";
import { httpRequest } from "../utils/http";

/**
 * WebDAV 客户端（思源版）
 * 跟 obsidian 端 webdav-native.ts 行为对齐，把 Obsidian requestUrl 换成 fetch
 */

export class WebDAVClient implements CloudClient {
  private url: string;
  private username: string;
  private password: string;
  private rootPath: string;

  constructor(url: string, username: string, password: string, basePath: string) {
    this.url = url.replace(/\/$/, "");
    this.username = username;
    this.password = password;
    this.rootPath = basePath.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  getRootPath(): string {
    return this.rootPath;
  }

  /**
   * 拼完整 URL，rootPath 只加一次
   */
  private getFullUrl(path: string): string {
    const cleanPath = path.replace(/^\/+/, "");
    if (this.rootPath && cleanPath) {
      return `${this.url}/${this.rootPath}/${cleanPath}`;
    }
    if (this.rootPath) return `${this.url}/${this.rootPath}`;
    return `${this.url}/${cleanPath}`;
  }

  private authHeader(): string {
    return `Basic ${btoa(`${this.username}:${this.password}`)}`;
  }

  private async webdavRequest(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: string
  ): Promise<{ status: number; text: string }> {
    const url = this.getFullUrl(path);
    const res = await httpRequest(url, {
      method,
      headers: { ...headers, Authorization: this.authHeader() },
      body,
      raw: true,
    });
    return { status: res.status, text: res.text };
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await this.webdavRequest("PROPFIND", "", { Depth: "0" });
      if (result.status === 207 || result.status === 200) {
        return { success: true };
      }
      if (result.status === 404) {
        // 试试根
        const rootResult = await this.webdavRequest("PROPFIND", "/", { Depth: "0" });
        if (rootResult.status === 207 || rootResult.status === 200) {
          return { success: false, error: `路径 "${this.rootPath}" 不存在` };
        }
      }
      return { success: false, error: `HTTP ${result.status}` };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async downloadManifest(): Promise<SyncManifest | null> {
    try {
      const result = await this.webdavRequest("GET", "batch-backup/SYNC_MANIFEST.json");
      if (result.status === 200) return JSON.parse(result.text) as SyncManifest;
      return null;
    } catch {
      return null;
    }
  }

  async downloadBoxesManifest(): Promise<BoxesManifest | null> {
    try {
      const result = await this.webdavRequest("GET", "boxes.json");
      if (result.status === 200) return JSON.parse(result.text) as BoxesManifest;
      return null;
    } catch {
      return null;
    }
  }

  async downloadZipBatch(fileName: string): Promise<ArrayBuffer | null> {
    try {
      const res = await httpRequest(this.getFullUrl(`batch-backup/${fileName}`), {
        method: "GET",
        headers: { Authorization: this.authHeader() },
        raw: true,
      });
      if (res.status === 200) return res.arrayBuffer;
      return null;
    } catch {
      return null;
    }
  }

  async downloadAtomicNote(path: string): Promise<AtomicNote | null> {
    let relativePath: string;
    if (path.startsWith(this.rootPath + "/")) {
      relativePath = path.slice(this.rootPath.length + 1);
    } else if (path.startsWith("/")) {
      relativePath = path.slice(1);
    } else {
      relativePath = path;
    }

    try {
      const result = await this.webdavRequest("GET", relativePath);
      if (result.status !== 200) return null;
      const data = JSON.parse(result.text);
      if (data.data && typeof data.data === "object") return data.data as AtomicNote;
      return data as AtomicNote;
    } catch {
      return null;
    }
  }

  async listNotes(): Promise<CloudFileInfo[]> {
    const files: CloudFileInfo[] = [];
    try {
      const result = await this.webdavRequest("PROPFIND", "notes/", { Depth: "1" });
      if (result.status !== 207) return files;

      // 用 DOMParser 解析 multistatus XML
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(result.text, "text/xml");
      const responses = xmlDoc.getElementsByTagNameNS("*", "response");

      for (let i = 1; i < responses.length; i++) {
        const response = responses[i];
        const href = response.getElementsByTagNameNS("*", "href")[0]?.textContent;
        const propStats = response.getElementsByTagNameNS("*", "propstat");
        if (!href || propStats.length === 0) continue;

        const props = propStats[0].getElementsByTagNameNS("*", "prop")[0];
        const etag = props?.getElementsByTagNameNS("*", "getetag")[0]?.textContent;
        const filename = decodeURIComponent(href.split("/").filter(Boolean).pop() || "");
        if (!filename.endsWith(".json")) continue;

        const noteId = filename.replace(".json", "");
        files.push({
          id: noteId,
          etag: etag || undefined,
          path: `notes/${filename}`,
        });
      }
    } catch {
      // ignore
    }
    return files;
  }

  async downloadAsset(remotePath: string): Promise<ArrayBuffer | null> {
    const url = remotePath.startsWith("http") ? remotePath : this.getFullUrl(remotePath);
    try {
      const res = await httpRequest(url, {
        method: "GET",
        headers: { Authorization: this.authHeader() },
        raw: true,
      });
      if (res.status === 200) return res.arrayBuffer;
      return null;
    } catch {
      return null;
    }
  }

  assetExistsLocally(_: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  async saveAssetToLocal(_: ArrayBuffer, __: string): Promise<void> {
    // 由 AssetHandler 实现
  }
}
