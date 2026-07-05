/**
 * HTTP 工具：fetch wrapper，带超时和重试
 * 用于直连 S3 / WebDAV（不走思源内核）
 */

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  timeoutMs?: number;
  /** 遇到 5xx / 网络错误时的最大重试次数（默认 0） */
  retries?: number;
  /** 不抛异常，把响应直接返回（用于 PROPFIND 等非 2xx 也算正常的请求） */
  raw?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
  arrayBuffer: ArrayBuffer;
}

export async function httpRequest(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
  const { retries = 0, timeoutMs = 60_000 } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method || "GET",
        headers: opts.headers,
        body: opts.body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const buf = await res.arrayBuffer();
      const text = new TextDecoder().decode(buf);

      if (!opts.raw && !res.ok) {
        // 5xx 重试
        if (res.status >= 500 && attempt < retries) {
          await sleep(2 ** attempt * 500);
          continue;
        }
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      return {
        status: res.status,
        headers: res.headers,
        text,
        arrayBuffer: buf,
      };
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < retries) {
        await sleep(2 ** attempt * 500);
        continue;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("http failed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
