import { CloudClient, CloudFileInfo } from "./cloud-client";
import { AtomicNote, BoxesManifest, SyncManifest } from "../types/inbox";
import type {
  S3Client as S3ClientType,
  ListObjectsV2Command as ListObjectsV2CommandCtor,
  GetObjectCommand as GetObjectCommandCtor,
  PutObjectCommand as PutObjectCommandCtor,
  ListObjectsV2CommandInput,
  _Object as S3Object,
} from "@aws-sdk/client-s3";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";

// 动态导入 AWS SDK v3，避免打包体积过大
let S3ClientClass: typeof S3ClientType | undefined;
let ListObjectsV2Command: typeof ListObjectsV2CommandCtor | undefined;
let GetObjectCommand: typeof GetObjectCommandCtor | undefined;
let PutObjectCommand: typeof PutObjectCommandCtor | undefined;

async function getAWSSDK() {
  if (!S3ClientClass || !ListObjectsV2Command || !GetObjectCommand || !PutObjectCommand) {
    const sdk = await import("@aws-sdk/client-s3");
    S3ClientClass = sdk.S3Client;
    ListObjectsV2Command = sdk.ListObjectsV2Command;
    GetObjectCommand = sdk.GetObjectCommand;
    PutObjectCommand = sdk.PutObjectCommand;
  }
  return { S3ClientClass, ListObjectsV2Command, GetObjectCommand, PutObjectCommand };
}

/**
 * S3 / S3 兼容存储客户端（思源版）
 * 跟 obsidian s3-client.ts 行为一致，requestHandler 用浏览器原生 fetch
 */
export class S3Client implements CloudClient {
  private client: InstanceType<typeof S3ClientType> | null = null;
  private bucket: string;
  private rootPath: string;
  private config: {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
  };

  constructor(
    endpoint: string,
    accessKey: string,
    secretKey: string,
    bucket: string,
    region: string,
    pathPrefix: string
  ) {
    let cleanEndpoint = endpoint.trim();
    if (!/^https?:\/\//.test(cleanEndpoint)) {
      cleanEndpoint = `https://${cleanEndpoint}`;
    }
    // 自动剥离 endpoint 中重复的 bucket 前缀（腾讯云那种 hostname）
    try {
      const uri = new URL(cleanEndpoint);
      if (uri.hostname.startsWith(`${bucket}.`)) {
        uri.hostname = uri.hostname.substring(bucket.length + 1);
        cleanEndpoint = uri.toString();
      }
    } catch {
      // ignore
    }

    this.config = {
      endpoint: cleanEndpoint,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      region: region || "us-east-1",
    };
    this.bucket = bucket;
    this.rootPath = pathPrefix.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  private async getClient() {
    if (!this.client) {
      const { S3ClientClass } = await getAWSSDK();
      this.client = new S3ClientClass({
        endpoint: this.config.endpoint,
        region: this.config.region,
        credentials: {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
        },
        requestHandler: new FetchHttpHandler({ requestTimeout: 30_000 }),
      });
    }
    return this.client;
  }

  getRootPath(): string {
    return this.rootPath;
  }

  private getObjectKey(key: string): string {
    const cleanKey = key.replace(/^\/+/, "");
    return this.rootPath ? `${this.rootPath}/${cleanKey}` : cleanKey;
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const client = await this.getClient();
      const { ListObjectsV2Command } = await getAWSSDK();
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.rootPath ? `${this.rootPath}/` : "",
        MaxKeys: 1,
      });
      await client.send(command);
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error & { name?: string };
      let friendly = err.message || String(err);
      if (err.name === "NoSuchBucket") friendly = `Bucket "${this.bucket}" 不存在`;
      else if (err.name === "InvalidAccessKeyId") friendly = "Access Key ID 无效";
      else if (err.name === "SignatureDoesNotMatch") friendly = "Secret Key 错误";
      else if (err.name === "AccessDenied") friendly = "访问被拒绝，请检查权限";
      return { success: false, error: friendly };
    }
  }

  async downloadManifest(): Promise<SyncManifest | null> {
    const key = this.getObjectKey("batch-backup/SYNC_MANIFEST.json");
    try {
      const text = await this.getObjectText(key);
      return text ? (JSON.parse(text) as SyncManifest) : null;
    } catch {
      return null;
    }
  }

  async downloadBoxesManifest(): Promise<BoxesManifest | null> {
    const key = this.getObjectKey("boxes.json");
    try {
      const text = await this.getObjectText(key);
      return text ? (JSON.parse(text) as BoxesManifest) : null;
    } catch {
      return null;
    }
  }

  async downloadZipBatch(fileName: string): Promise<ArrayBuffer | null> {
    const key = this.getObjectKey(`batch-backup/${fileName}`);
    try {
      return await this.getObjectBuffer(key);
    } catch {
      return null;
    }
  }

  async downloadAtomicNote(path: string): Promise<AtomicNote | null> {
    let objectKey: string;
    if (path.startsWith("/")) objectKey = path.slice(1);
    else if (this.rootPath && path.startsWith(this.rootPath + "/")) objectKey = path;
    else objectKey = this.getObjectKey(path);

    try {
      const text = await this.getObjectText(objectKey);
      if (!text) return null;
      const data = JSON.parse(text);
      if (data.data && typeof data.data === "object") return data.data as AtomicNote;
      return data as AtomicNote;
    } catch {
      return null;
    }
  }

  /**
  async listNotes(): Promise<CloudFileInfo[]> {
    const notesPrefix = this.getObjectKey("notes/");
    const files: CloudFileInfo[] = [];
    try {
      const client = await this.getClient();
      const { ListObjectsV2Command } = await getAWSSDK();

      let continuationToken: string | undefined;
      do {
        const input: ListObjectsV2CommandInput = {
          Bucket: this.bucket,
          Prefix: notesPrefix,
          ContinuationToken: continuationToken,
        };
        const response = await client.send(new ListObjectsV2Command(input));
        if (response.Contents) {
          for (const object of response.Contents as S3Object[]) {
            if (!object.Key || !object.Key.endsWith(".json")) continue;
            const fileName = object.Key.split("/").pop() || "";
            const noteId = fileName.replace(".json", "");
            files.push({
              id: noteId,
              etag: object.ETag?.replace(/"/g, "") || "",
              mtime: object.LastModified?.getTime() || 0,
              size: object.Size || 0,
              path: object.Key,
            });
          }
        }
        continuationToken = response.NextContinuationToken;
      } while (continuationToken);
    } catch (error) {
      console.warn("[S3] listNotes error:", error);
    }
    return files;
  }

  async downloadAsset(remotePath: string): Promise<ArrayBuffer | null> {
    let objectKey: string;
    if (remotePath.startsWith("http")) {
      try {
        const url = new URL(remotePath);
        let key = decodeURIComponent(url.pathname).replace(/^\/+/, "");
        if (key.startsWith(this.bucket + "/")) key = key.substring(this.bucket.length + 1);
        objectKey = key;
      } catch {
        return null;
      }
    } else {
      const cleanPath = remotePath.replace(/^\/+/, "");
      if (this.rootPath && cleanPath.startsWith(this.rootPath + "/")) objectKey = cleanPath;
      else objectKey = this.getObjectKey(remotePath);
    }

    try {
      return await this.getObjectBuffer(objectKey);
    } catch (error) {
      console.error(`[S3] downloadAsset 失败: ${remotePath}`, error);
      return null;
    }
  }

  assetExistsLocally(_: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  async saveAssetToLocal(_: ArrayBuffer, __: string): Promise<void> {
    // 由 AssetHandler 实现
  }

  // ============ 私有辅助 ============

  private async getObjectText(key: string): Promise<string | null> {
    const client = await this.getClient();
    const { GetObjectCommand } = await getAWSSDK();
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!response.Body) return null;
      return typeof response.Body === "string"
        ? response.Body
        : await new Response(response.Body as ReadableStream).text();
    } catch (err: unknown) {
      const e = err as { name?: string };
      if (e?.name === "NoSuchKey" || e?.name === "NotFound") return null;
      throw err;
    }
  }

  private async getObjectBuffer(key: string): Promise<ArrayBuffer | null> {
    const client = await this.getClient();
    const { GetObjectCommand } = await getAWSSDK();
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!response.Body) return null;
      return await new Response(response.Body as ReadableStream).arrayBuffer();
    } catch (err: unknown) {
      const e = err as { name?: string };
      if (e?.name === "NoSuchKey" || e?.name === "NotFound") return null;
      throw err;
    }
  }
}
