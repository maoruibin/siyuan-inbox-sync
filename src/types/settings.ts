/**
 * 插件设置类型定义
 * 字段命名跟 obsidian-inbox-sync 对齐，便于参考；siyuan* 前缀是思源特有
 */

export interface InboxSyncSettings {
  // 云存储配置
  storageType: "webdav" | "s3";

  // WebDAV 配置
  webdavUrl: string;
  webdavUsername: string;
  webdavPassword: string;

  // S3 配置
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Bucket: string;
  s3Region: string;

  // 云端根路径（如 "inBox"，调试时可改成 "inBoxDebug"）
  cloudRootPath: string;

  // 思源目标
  siyuanNotebookId: string;     // 目标笔记本 ID
  siyuanBasePath: string;       // 笔记本下子路径（如 "/inBox"，空串=笔记本根）

  // 同步设置
  syncInterval: number;         // 自动同步间隔（分钟），0 表示禁用
  enableAutoSync: boolean;

  // 开发者选项
  debugRootPath: string;        // 空=用 cloudRootPath，否则用 debugRootPath
}

export const DEFAULT_SETTINGS: InboxSyncSettings = {
  storageType: "webdav",

  webdavUrl: "",
  webdavUsername: "",
  webdavPassword: "",

  s3Endpoint: "",
  s3AccessKey: "",
  s3SecretKey: "",
  s3Bucket: "",
  s3Region: "us-east-1",

  cloudRootPath: "inBox",

  siyuanNotebookId: "",
  siyuanBasePath: "",

  syncInterval: 30,
  enableAutoSync: false,

  debugRootPath: "",
};

/**
 * 获取实际的云端根路径
 * 生产: cloudRootPath（默认 "inBox"）
 * 调试: debugRootPath（如 "inBoxDebug"）
 */
export function getCloudRootPath(settings: InboxSyncSettings): string {
  return settings.debugRootPath || settings.cloudRootPath || "inBox";
}
