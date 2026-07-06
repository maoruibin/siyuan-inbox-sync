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
 * 通过 docId 移动文档到指定路径
 * 思源 moveDocs 的 fromPaths 期望路径数组（hpath），docId 内部容忍但不保证未来版本兼容，
 * 这里先用 SQL 把 docId 转成 hpath 再传，更稳妥。
 */
export async function moveDocToPath(
  docId: string,
  toPath: string,
  notebook: string
): Promise<void> {
  const hpath = await getDocPath(docId);
  await callApi("api/filetree/moveDocs", {
    fromPaths: [hpath],
    toNotebook: notebook,
    toPath,
  });
}

/** 通过 SQL 拿文档的 hpath（人类可读路径） */
async function getDocPath(docId: string): Promise<string> {
  const stmt = `SELECT hpath FROM blocks WHERE type='d' AND id='${docId.replace(/'/g, "''")}' LIMIT 1`;
  const rows = await callApi<Array<{ hpath: string }>>("api/query/sql", { stmt });
  return rows[0]?.hpath ?? `/${docId}`;
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
 * 上传阶段需要扫描的 inBox 文档信息
 * updated: 思源块的更新时间（秒级时间戳字符串，h12:34:56 形式或纯数字）
 */
export interface InboxDocInfo {
  docId: string;
  noteId: string;
  title: string;
  updated: string;
  boxName?: string;
  boxId?: string;
  parentId?: string;
  tags?: string;
  inboxCreated?: string;
  inboxUpdated?: string;
}

/**
 * 一次性扫描笔记本下所有带 custom-inbox-id 的文档
 * 用于上传阶段对比本地 updated vs metadata 里记录的基线，识别本地变化
 */
export async function listAllInboxDocs(notebookId: string): Promise<InboxDocInfo[]> {
  const stmt = `SELECT b.id AS doc_id, b.content AS title, b.updated,
    a_inbox.value AS inbox_id,
    a_box.value AS box_name,
    a_box_id.value AS inbox_box_id,
    a_parent.value AS inbox_parent,
    a_tags.value AS inbox_tags,
    a_created.value AS inbox_created,
    a_updated.value AS inbox_updated
    FROM blocks b
    JOIN attributes a_inbox ON a_inbox.block_id = b.id AND a_inbox.name = 'custom-inbox-id'
    LEFT JOIN attributes a_box ON a_box.block_id = b.id AND a_box.name = 'custom-box'
    LEFT JOIN attributes a_box_id ON a_box_id.block_id = b.id AND a_box_id.name = 'custom-inbox-box-id'
    LEFT JOIN attributes a_parent ON a_parent.block_id = b.id AND a_parent.name = 'custom-inbox-parent'
    LEFT JOIN attributes a_tags ON a_tags.block_id = b.id AND a_tags.name = 'custom-inbox-tags'
    LEFT JOIN attributes a_created ON a_created.block_id = b.id AND a_created.name = 'custom-inbox-created'
    LEFT JOIN attributes a_updated ON a_updated.block_id = b.id AND a_updated.name = 'custom-inbox-updated'
    WHERE b.type = 'd' AND b.box = '${notebookId.replace(/'/g, "''")}'`;

  const rows = await callApi<Record<string, unknown>[]>("api/query/sql", { stmt });
  return rows.map((r) => ({
    docId: String(r.doc_id ?? ""),
    noteId: String(r.inbox_id ?? ""),
    title: String(r.title ?? ""),
    updated: String(r.updated ?? ""),
    boxName: r.box_name ? String(r.box_name) : undefined,
    boxId: r.inbox_box_id ? String(r.inbox_box_id) : undefined,
    parentId: r.inbox_parent ? String(r.inbox_parent) : undefined,
    tags: r.inbox_tags ? String(r.inbox_tags) : undefined,
    inboxCreated: r.inbox_created ? String(r.inbox_created) : undefined,
    inboxUpdated: r.inbox_updated ? String(r.inbox_updated) : undefined,
  }));
}

/**
 * 导出文档为 markdown 字符串
 * 用于上传阶段拿思源文档的最新内容
 */
export async function exportDocMarkdown(docId: string): Promise<string> {
  const data = await callApi<{ content: string }>("api/export/exportMdContent", { id: docId });
  return data.content || "";
}

export interface BoxDocInfo {
  docId: string;
  title: string;
  hpath: string;
}

/**
 * 查指定 boxId 下的所有文档（用于盒子 rename/dissolve 批量操作）
 * 走 custom-inbox-box-id 属性反查，比 listAllInboxDocs 全表扫更快
 */
export async function listDocsByBoxId(
  notebookId: string,
  boxId: string
): Promise<BoxDocInfo[]> {
  const stmt = `SELECT b.id AS doc_id, b.content AS title, b.hpath
    FROM blocks b
    JOIN attributes a ON a.block_id = b.id AND a.name = 'custom-inbox-box-id'
    WHERE b.type = 'd' AND b.box = '${notebookId.replace(/'/g, "''")}'
    AND a.value = '${boxId.replace(/'/g, "''")}'`;
  const rows = await callApi<Record<string, unknown>[]>("api/query/sql", { stmt });
  return rows.map((r) => ({
    docId: String(r.doc_id ?? ""),
    title: String(r.title ?? ""),
    hpath: String(r.hpath ?? ""),
  }));
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
