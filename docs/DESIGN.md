# inBox Sync for SiYuan — 设计文档

> 把 [inBox](https://inbox.gudong.site) 笔记**单向同步**到 [思源笔记](https://b3log.org/siyuan/) 的插件。
> inBox 是收集箱，编辑/删除交给桌面端做。插件只读云端，不在思源里改云端数据。
> 跟 [obsidian-inbox-sync](https://github.com/maoruibin/obsidian-inbox-sync) 共用同一套同步协议。

本文档面向开发者,描述架构、数据流、关键决策、协议字段、踩过的坑。用户视角的安装使用见 [README](../README.md)。

---

## 1. 架构总览

```
src/
├── index.ts              # 插件入口：顶栏图标、设置入口、同步触发
├── types/
│   ├── inbox.ts          # atomicNote / boxes / ParsedNote / SyncMetadata
│   └── settings.ts       # InboxSyncSettings（含 webdav / s3 / siyuan 字段）
├── sync/
│   ├── cloud-client.ts   # CloudClient 接口（listNotes / downloadAtomicNote）
│   ├── webdav-client.ts  # WebDAV 实现（PROPFIND / GET + Basic Auth + no-cache header）
│   ├── s3-client.ts      # S3 实现（AWS SDK v3 + fetch-http-handler）
│   ├── note-parser.ts    # parse（云端→内部,无反向 serialize）
│   ├── siyuan-writer.ts  # 写入思源（createDoc / setBlockAttrs / deleteNote）
│   ├── asset-handler.ts  # 资源（图片/录音/附件）下载并落地到 data/assets/inbox-sync/
│   └── sync-manager.ts   # 协调器（仅下载阶段）
├── storage/
│   └── metadata-storage.ts  # 增量同步元数据（plugin.loadData/saveData）
├── ui/
│   └── settings-dialog.ts   # 设置对话框（原生 Dialog）
└── utils/
    ├── siyuan-api.ts     # 思源 /api 调用封装
    └── http.ts           # fetch wrapper（超时/重试）
```

### 分层职责

| 层 | 职责 |
|---|---|
| **index.ts** | 思源插件入口,管理生命周期、UI、定时同步 |
| **sync/** | 同步协议实现,平台无关(思源 API 通过 utils 注入) |
| **storage/** | 本地状态持久化 |
| **ui/** | 用户交互 |
| **utils/** | 平台 API 封装,隔离思源/HTTP 细节 |

`types/inbox.ts` 是从 obsidian 端直接复制的纯逻辑类型,不含平台依赖。

---

## 2. 同步流程

### 2.1 整体时序（单向：云端 → 思源）

```
点击同步
  │
  ▼
1. 加载本地 metadata
  │
  ▼
2. 拉 boxes.json → 构建 boxId→name 映射
   • boxes 为空 → writer.setBoxFolderEnabled(false)，笔记平铺到根
   • boxes 非空 → 启用盒子分文件夹
  │
  ▼
3. listNotes() 拉云端文件清单（ETag/mtime）
  │
  ▼
4. diffCloudAndLocal() 增量对比
   • toDownload：本地无或云端 ETag/mtime 变了
   • toDelete：metadata 有但云端清单没有
   • unchanged
  │
  ▼
5. 处理云端删除（toDelete）
   • removeDoc(meta.docId)
   • 从 metadata 移除
  │
  ▼
6. 下载阶段（toDownload）
   • downloadAtomicNote → parse → writer.writeNote
   • writeNote 内：删旧建新（removeDoc + createDocWithMd）
   • handleAssets（资源落地）
   • 设置 custom-* 属性（setBlockAttrs）
  │
  ▼
7. 第二轮：父子批注引用
   • 子笔记（parentId）作为父笔记末尾的块引用
  │
  ▼
8. 保存 metadata
```

> 单向同步：思源里编辑/删除文档不会回传到云端。inBox App 是收集端，思源是工作台。

### 2.2 关键策略

#### 删旧建新（更新策略）
更新笔记时不做块级 patch,直接 `removeDoc(oldDocId)` + `createDocWithMd(newMarkdown)`。原因:
- 思源 markdown 重新解析最稳
- 块级更新（updateBlock）容易留残块
- 代价：docId 会变,所以 metadata 必须同步更新

#### 单向语义
- inBox App 是收集端：所有笔记/批注/盒子都在 App 端创建
- 思源是工作台：用户在思源里编辑、整理、删除都只影响思源本地
- 插件只读云端：下载 + 资源落地,不上传任何修改
- 云端笔记 `flags.is_removed=true` → 插件移除思源对应文档（软删除传播到本地）

---

## 3. 数据结构

### 3.1 atomicNote（云端格式）

inBox 协议的核心数据结构,存储为 `notes/note-xxx.json`。

```typescript
interface AtomicNote {
  id: string;               // "note-{20位短ID}"
  ver?: number;             // 协议版本，当前 2
  content: {
    title: string;
    content: string;        // markdown 正文
    assets?: XResourceInfo[];
    links?: NoteLink[];
    box_id?: string;        // 盒子归属
    box?: string;           // 旧协议字段，只读
  };
  meta: {
    created_at: string;     // ISO 时间戳（Android snake_case）
    updated_at: string;
    device_id?: string;
  };
  flags: {
    is_removed?: boolean;   // 软删除标记
    is_top?: boolean;
    favorite?: boolean;
  };
  annotations?: AtomicNoteAnnotation[];  // ver=2 内联批注
  parentId: string | null;  // 父笔记（独立批注子笔记用）
  imageJson: string;        // JSON 编码的图片资源数组
  extra: string;            // JSON 编码的额外信息（录音等）
  blockId: number;          // 旧格式 Card123 链接用
}
```

**字段命名兼容**：camelCase（Web/PC）和 snake_case（Android）双兼容,parser 自动处理。

### 3.2 boxes.json（盒子清单）

```typescript
interface BoxesManifest {
  ver?: number;
  updated_at?: number;
  boxes: BoxInfo[];
}

interface BoxInfo {
  box_id: string;
  name: string;
  is_default?: boolean;
  sort_index?: number;
  created_at?: number;
  updated_at?: number;
  deleted_at?: number | null;  // 非 null = 已删除（墓碑）
}
```

**关键**：`deleted_at` 是软删除,清单里仍保留。`buildBoxNameMap` 过滤掉这些。

### 3.3 ParsedNote（内部表示）

`NoteParser.parse(atomicNote)` 把云端格式转成内部 `ParsedNote`,所有下游(writer、asset-handler)都用这个。

单向同步：不提供反向 serialize，思源里的修改不会回传到云端。

### 3.4 SyncMetadata（增量同步元数据）

存储位置：`plugin.loadData("sync-meta.json")` / `saveData`。

```typescript
interface SyncMetadata {
  lastSyncTime: number;
  lastSyncMeta: Record<string, NoteSyncMeta>;  // noteId -> meta
  version: string;
}

interface NoteSyncMeta {
  etag: string;                // 云端 ETag
  mtime: number;               // 云端最后修改时间（毫秒）
  docId?: string;              // 思源文档 ID
}
```

---

## 4. 字段映射

### atomicNote → 思源文档

| atomicNote 字段 | 思源落点 |
|---|---|
| `id` | 文档自定义属性 `custom-inbox-id` |
| `content.title` | 文档名（无标题时用创建时间） |
| `content.content` | 文档正文块 |
| `meta.created_at` / `updated_at` | `custom-inbox-created` / `-updated` |
| `content.box_id`（经 boxes.json 解析为名称） | `custom-box`（无盒子不写）+ 文件夹归属 |
| `tags`（从正文 `#tag` 提取） | `custom-inbox-tags`（空格分隔），正文保留 `#tag` |
| `parentId` | `custom-inbox-parent`（noteId） |
| ver=2 内联 `annotations[]` | 父笔记末尾的 `> **批注**` 引用块 |
| 独立批注子笔记（有 `parentId`） | 独立文档 + 父笔记末尾的块引用 |

### 资源

资源（图片/录音/附件）落到 `data/assets/inbox-sync/{images|videos|audios|attachments}/`。
markdown 引用 `assets/inbox-sync/{type}/{filename}`,思源按相对路径解析。

写入必须走 `/api/file/putFile`,**禁止 node fs**（否则破坏内核块树索引）。

---

## 5. 关键设计决策

| 主题 | 决策 | 理由 |
|---|---|---|
| **同步方向** | 单向（云端 → 思源） | inBox 是收集箱,编辑/删除交给桌面端做;避免双向同步的复杂性 + 误删风险 |
| **更新策略** | 删旧建新 | 块级 patch 容易留残块;重新解析 markdown 最稳 |
| **盒子分文件夹** | boxes.json 非空才启用;无盒子进根平铺 | 跟 inBox App 是否启用盒子功能的状态联动 |
| **盒子管理** | 只读 boxes.json,创建/重命名/删除在 inBox App | 简化 + 跟客户端职责分离 |
| **新建笔记** | 不支持（在 inBox App 创建） | 避免 noteId 冲突 + scope 决策复杂 |
| **删除语义** | 云端 `flags.is_removed=true` → 移除思源文档 | 跟 inBox App 行为一致;思源里删文档不影响云端 |
| **打包格式** | esbuild `cjs` | 思源用 require-like 加载器;不支持 ESM 的 `import` |
| **存储格式** | strict TS + esbuild bundle | 跟思源官方插件模板对齐 |

---

## 6. 思源 API 红线

### 6.1 必须走 `/api/file/*`

所有 `data/` 下的文件操作（资源、metadata、配置）必须走 `/api/file/putFile`、`/api/file/getFile`。
**禁止 node fs / electron**。原因：思源内核维护块树索引,绕过会损坏数据。

### 6.2 文档操作

| 操作 | API |
|---|---|
| 新建文档 | `/api/filetree/createDocWithMd`（md → blocks 自动转换） |
| 删除文档 | `/api/filetree/removeDoc`（移入回收站） |
| 重命名 | `/api/filetree/renameDoc` |
| 设置属性 | `/api/attr/setBlockAttrs`（key 必须 `custom-` 开头） |
| 拿属性 | `/api/attr/getBlockAttrs` |
| 追加块 | `/api/block/insertBlock`（parentID 模式） |
| 导出 markdown | `/api/export/exportMdContent` |
| SQL 查询 | `/api/query/sql`（用 `box` 字段过滤笔记本） |

### 6.3 思源 eventBus

可以监听的事件有限,而且删除事件经常丢（用户用快捷键、清空回收站）。
所以**可靠方案是全量扫描 + 对比 metadata**,不依赖事件。

---

## 7. 踩过的坑

### 7.1 打包格式（关键）

| 格式 | 现象 |
|---|---|
| `iife` | `plugin has no export`（IIFE 不暴露 export） |
| `esm` | `Cannot use import statement outside a module`（思源用普通 `<script>` 加载,不是 module 类型） |
| **`cjs`** | ✅ 思源有 require-like 加载器,正确处理 `module.exports` |

**结论**：esbuild 用 `format: "cjs"`,跟思源官方插件模板对齐。

### 7.2 `setBlockAttrs` 触发 `updated`

思源文档块的 `updated` 字段会被任何块操作触发,包括我们自己调用 `setBlockAttrs`。
必须用基线机制（见 2.2）避免无限循环。

### 7.3 `loadData` / `saveData` 必须传文件名

思源 Plugin API：
- `loadData(name: string): Promise<unknown>` — 必须传文件名
- `saveData(name: string, data: unknown): Promise<IWebSocketData>` — 必须传文件名和数据

返回值类型是 `IWebSocketData`（不是 void）,所以 PluginStorage 接口用 `Promise<unknown>`。

### 7.4 坚果云 WebDAV 认证

坚果云的 WebDAV **不接受账号登录密码**,必须用「应用密码」:
- 网页 → 账户信息 → 安全选项 → 第三方应用管理 → 添加应用 → 生成应用密码
- 用户名是完整邮箱

### 7.5 `showMessage` duration=0 = 永久

`showMessage(msg, 0, "info")` 会让通知永久不消失,大量堆积。同步进度改用 console.debug,只在开始/结束各弹一次短通知。

---

## 8. 版本节奏

| 版本 | 范围 | 状态 |
|---|---|---|
| **v0.1** | 单向同步、盒子作为属性 | 已发布 |
| **v0.2** | 修改/删除双向、盒子分文件夹 | 已废弃（双向同步方案撤回,回归单向） |
| **v0.3** | 单向同步、盒子分文件夹、WebDAV no-cache | 进行中 |
| 后续 | 笔记新建支持（带 scope 限制） | 未开始 |

---

## 9. 协议参考

权威文档：[`ThinkPlus/docs/inbox-tech/sync/README.md`](https://github.com/maoruibin/ThinkPlus)（私有）。

公开参考实现：
- [obsidian-inbox-sync](https://github.com/maoruibin/obsidian-inbox-sync) — 同协议的 Obsidian 端
- 本项目 — 思源端,跟 Obsidian 端实现完全对齐

## 10. License

MIT
