/**
 * 思源笔记内核 API 封装
 * 端点：POST /api/...，同源调用，不需要 token
 *
 * 红线：所有 data/ 下的文件操作必须走这里，禁止 node fs
 */

const API_BASE = "/";

interface ApiResult<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

async function callApi<T = unknown>(endpoint: string, payload: unknown): Promise<T> {
  const res = await fetch(API_BASE + endpoint.replace(/^\//, ""), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`/api ${endpoint} failed: HTTP ${res.status}, ${text.slice(0, 200)}`);
  }

  let parsed: ApiResult<T>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`/api ${endpoint} returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (parsed.code !== 0) {
    throw new Error(`/api ${endpoint} error: code=${parsed.code}, msg=${parsed.msg}`);
  }

  return parsed.data;
}

// ============ 文档树 ============

export interface CreatedDoc {
  /** 文档的 block ID */
  docId: string;
}

/**
 * 用 markdown 创建一个新文档
 * @param notebook 笔记本 ID
 * @param path 文档路径，如 "/inBox/foo" 或 "/inBox/2024-01-01 bar"
 * @param markdown 文档内容（会被解析成块）
 */
export function createDocWithMd(
  notebook: string,
  path: string,
  markdown: string
): Promise<string> {
  return callApi<string>("api/filetree/createDocWithMd", {
    notebook,
    path,
    markdown,
  });
}

/**
 * 删除文档（移入回收站，可恢复）
 */
export function removeDoc(docId: string): Promise<void> {
  return callApi("api/filetree/removeDoc", { id: docId }).then(() => undefined);
}

/**
 * 重命名文档
 */
export function renameDoc(docId: string, title: string): Promise<void> {
  return callApi("api/filetree/renameDoc", { id: docId, title }).then(() => undefined);
}

/**
 * 通过路径移动文档
 */
export function moveDocsById(fromId: string, toPath: string, notebook: string): Promise<void> {
  return callApi("api/filetree/moveDocs", { fromPaths: [fromId], toNotebook: notebook, toPath }).then(() => undefined);
}

// ============ 块操作 ============

/**
 * 设置文档/块的自定义属性
 * attrs 的 key 必须以 `custom-` 开头（思源约束）
 */
export function setBlockAttrs(
  blockId: string,
  attrs: Record<string, string>
): Promise<void> {
  return callApi("api/attr/setBlockAttrs", { id: blockId, attrs }).then(() => undefined);
}

/**
 * 获取块的属性
 */
export function getBlockAttrs(blockId: string): Promise<Record<string, string>> {
  return callApi("api/attr/getBlockAttrs", { id: blockId });
}

/**
 * 在指定块后插入新块
 */
export function insertBlockAfter(previousId: string, markdown: string): Promise<string> {
  return callApi<string>("api/block/insertBlock", {
    dataType: "markdown",
    data: markdown,
    previousID: previousId,
  });
}

/**
 * 在文档末尾追加块
 */
export function appendBlockToDoc(parentDocId: string, markdown: string): Promise<string> {
  return callApi<string>("api/block/insertBlock", {
    dataType: "markdown",
    data: markdown,
    parentID: parentDocId,
  });
}

/**
 * 删除块
 */
export function deleteBlock(blockId: string): Promise<void> {
  return callApi("api/block/deleteBlock", { id: blockId }).then(() => undefined);
}

// ============ 文件 I/O（必须走这里，禁止 node fs）============

/**
 * 读取 data/ 下的文本文件
 * @param path 形如 "/data/storage/petal/foo/bar.json"
 */
export async function getFileText(path: string): Promise<string | null> {
  const res = await fetch("/api/file/getFile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getFile failed: HTTP ${res.status}`);
  return res.text();
}

/**
 * 上传二进制到 data/ 下指定路径
 * @param path 形如 "/data/assets/inbox-sync/images/img-xxx.png"
 * @param buffer 文件内容
 * @param modTime 毫秒时间戳，可选
 */
export async function putFile(
  path: string,
  buffer: ArrayBuffer,
  modTime?: number
): Promise<void> {
  const form = new FormData();
  form.append("path", path);
  form.append("file", new Blob([buffer]));
  if (modTime !== undefined) form.append("modTime", String(modTime));

  const res = await fetch("/api/file/putFile", {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`putFile failed: HTTP ${res.status}, ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(await res.text());
  if (parsed.code !== 0) {
    throw new Error(`putFile error: ${parsed.msg}`);
  }
}

// ============ 笔记本 ============

export interface Notebook {
  id: string;
  name: string;
  icon: string;
  sort: number;
  closed: boolean;
}

interface LsNotebooksData {
  notebooks: Notebook[];
}

export async function listNotebooks(): Promise<Notebook[]> {
  const data = await callApi<LsNotebooksData>("api/notebook/lsNotebooks", {});
  return data.notebooks.filter((nb) => !nb.closed);
}

// ============ 查询（用于反查 docId，作为元数据兜底）============

interface BlockRow {
  id: string;
  type: string;
  content: string;
  [k: string]: unknown;
}

export async function queryDocsByCustomAttr(key: string, value: string): Promise<BlockRow[]> {
  // key 形如 "custom-inbox-id"
  const stmt = `SELECT id, type, content FROM blocks WHERE type = 'd' AND \`${key}\` = '${value.replace(/'/g, "''")}' LIMIT 10`;
  const rows = await callApi<BlockRow[]>("api/query/sql", { stmt });
  return rows;
}

/**
 * 创建文档目录路径（如 /inBox/sub 存在时跳过；不存在时按层级建）
 */
export async function ensureDocPath(notebook: string, path: string): Promise<void> {
  // 思源会自动在 createDocWithMd 时建中间路径；这里只做兜底
  // 留空实现，未来若需要可补充
  void notebook;
  void path;
}
