# inBox Sync for SiYuan

把 [inBox](https://inbox.gudong.site) 笔记**单向同步**到 [思源笔记](https://b3log.org/siyuan/) 的插件。

支持 WebDAV / S3 兼容存储，增量同步、资源（图片/录音/附件）、批注、盒子（作为文档自定义属性）。

> inBox 是"收集箱"，编辑和删除交给桌面端做。插件只读云端，不在思源里修改云端数据。
> 跟同名的 [Obsidian 插件](https://github.com/maoruibin/obsidian-inbox-sync) 共用同一套同步协议。

## 功能

- **单向同步（云端 → 思源）**：只下载不上传
  - inBox App 是收集端，思源是工作台
  - 在思源里编辑/删除文档不会回传到云端
  - 不支持在思源里新建笔记（新笔记请在 inBox App 创建）
- **多存储后端**：WebDAV / S3（含 Bitiful、腾讯云 COS、阿里 OSS 等 S3 兼容服务）
- **增量同步**：基于 ETag + mtime，未变化的笔记直接跳过
- **资源同步**：图片、视频、录音、附件，落到 `data/assets/inbox-sync/`
- **批注支持**：ver=2 内联批注渲染为父笔记末尾的 blockquote；带 `parentId` 的独立批注作为父笔记末尾的块引用
- **盒子分文件夹**：笔记按盒子归到 `/{盒子名}/` 子文档下，无盒子进根目录平铺。盒子改名/删除时自动对账（批量 move 文档到新路径 + 同步 `custom-box`）
- **笔记间链接**：保留 inBox 原文 `[[note-xxx]]`（v1 以纯文本展示，块级转换在 v2 实现）

### 删除语义

- 在 inBox App 删除笔记 → 云端 `flags.is_removed=true` → 插件下次同步时移除思源对应文档
- 在思源里删文档 → **不影响云端**（单向，思源是只读副本）

## 安装

### 方式 1：手动安装（推荐）

1. 从 [Releases](../../releases) 下载最新的 `package.zip`
2. 在思源笔记里打开文件管理器，进入工作空间的 `data/plugins/` 目录
3. 新建文件夹 `siyuan-inbox-sync/`，把 `package.zip` 里的所有文件解压到该目录
4. 重启思源或在 `设置 → 饥饿插件` 中点 `刷新`，然后启用 `inBox 同步`

### 方式 2：从源码构建

```bash
git clone https://github.com/maoruibin/siyuan-inbox-sync.git
cd siyuan-inbox-sync
npm install
npm run package     # 一键构建 + 打包成 package.zip
```

把生成的 `package.zip` 解压到 `data/plugins/siyuan-inbox-sync/` 即可。开发时可以用 `npm run dev` watch 模式 + 软链到插件目录。

## 使用

### 第 1 步：选目标笔记本

在思源里建一个专门存放同步笔记的笔记本（比如叫「inBox」），后面在插件设置里要选它。

### 第 2 步：配置云端

打开插件设置（顶栏图标 → 设置），按你的存储类型填：

**WebDAV**：
- URL：你的 WebDAV 服务地址（如 `https://dav.example.com/`）
- 用户名 / 密码
- 云端根目录：默认 `inBox`，对应 inBox App 的同步根

**S3 兼容**：
- Endpoint：如 `https://s3.bitiful.net` 或腾讯云 COS 地址
- Access Key / Secret Key / Bucket / Region
- 同上，云端根目录默认 `inBox`

### 第 3 步：选笔记本 + 子路径

- **目标笔记本**：下拉选第 1 步建的那个
- **子路径**：可选，比如填 `/inBox`，所有笔记会落到笔记本下的 `/inBox/` 文档下；留空就是笔记本根

### 第 4 步：测试连接 → 立即同步

点 `测试连接`，验证云存储可达。然后点顶栏的同步图标（或设置里 `立即同步`），第一次会拉全部笔记，之后只拉变化的。

## 字段映射

inBox 的 atomicNote → 思源文档：

| inBox 字段 | 思源落点 |
|---|---|
| `id` (note-xxx) | 文档自定义属性 `custom-inbox-id` |
| `content.title` | 文档名（无标题时用创建时间） |
| `content.content` | 文档正文块 |
| `meta.created_at` / `updated_at` | `custom-inbox-created` / `-updated` |
| `content.box_id`（经 boxes.json 解析为名称） | `custom-box`（无盒子不写） |
| `tags`（从正文 `#tag` 提取） | `custom-inbox-tags`，正文保留 `#tag` |
| `parentId` | `custom-inbox-parent`（noteId） |
| ver=2 内联 `annotations[]` | 父笔记末尾的 `> **批注**` 引用块 |
| 独立批注子笔记（有 `parentId`） | 独立文档 + 父笔记末尾的块引用 `((childDocId))` |

资源（图片/录音/附件）落到 `data/assets/inbox-sync/{images|videos|audios|attachments}/`。

## 工作原理

```
inBox 云端（WebDAV / S3）
   │
   ├─ boxes.json          ← 盒子清单（box_id → name）
   ├─ notes/note-xxx.json  ← atomicNote（含 ver=2 内联批注）
   └─ batch-backup/*.zip   ← 批量包（暂未启用）
        │
        ▼
  本插件（增量同步：ETag 对比）
        │
        ▼
  思源笔记本（custom-* 属性 + assets/inbox-sync/）
```

更新策略：**删旧建新**。每次更新会移除旧文档、用最新 markdown 重新创建（思源的块树会重新解析）。文档 ID 会变，但 `custom-inbox-id` 保持稳定，增量元数据里也记录最新 docId。

## 文档树结构

同步后的思源笔记本按盒子组织（v0.3+）：

```
{笔记本}/
├── inBox/                         # 子路径（可在设置里改）
│   ├── 默认笔记.md                # 无盒子笔记(根平铺)
│   ├── 工作/                      # "工作"盒子下所有笔记
│   │   ├── project-xxx.md
│   │   └── meeting-notes.md
│   └── 生活/                      # "生活"盒子
│       └── shopping.md
└── assets/inbox-sync/             # 资源(所有盒子共享, 不按盒子分)
```

**盒子文件夹规则：**

- 笔记 `content.box_id` 在云端 `boxes.json` 里查到 → 进 `<盒子名>/` 子文档
- 否则（无盒子 / 盒子被删墓碑 / boxes.json 为空）→ 根平铺
- 盒子在 inBox App 改名 → 该 boxId 下所有文档 move 到新路径 + 同步更新 `custom-box`
- 盒子在 inBox App 删除（deleted_at 墓碑）→ 该 boxId 下所有文档 move 回根 + 清 `custom-box`
- `custom-inbox-box-id` **永远保留**（作为反查锚，即使盒子删除也不清，便于撤销恢复）
- 资源统一放 `data/assets/inbox-sync/`，不按盒子分

**盒子名清洗规则：** `/ \ : * ? " < > |` 替换为 `-`，空名 fallback 到 boxId 短码，撞名追加 boxId 短码后缀（如 `工作-boxabc12`）。

**对账时机：** 每次同步开始时，`SyncManager` 会拉云端 `boxes.json` 跟本地 `metadata.boxFolders` 对比，按需批量 move 文档。对账失败不阻断主同步流程（仅打 warn）。

## 已知限制

- **不支持在思源里新建笔记**：新建请在 inBox App 完成，插件只同步已有 noteId 的笔记
- **不支持回传**：在思源里编辑/删除文档不会影响云端（单向同步）
- **盒子管理**：盒子的创建/重命名/删除需在 inBox App 完成（插件只读 boxes.json），但插件会自动对账 App 端的盒子改名/删除（批量 move 文档到新路径）
- `[[note-xxx]]` 笔记间链接暂未转换为思源块引用，正文里以纯文本展示
- 父笔记的批注引用块在重复 sync 时会累积（v3 会加自动清理）
- 桌面端思源优先；移动端有 CORS 限制，可能需要走 `/api/network/forwardProxy`（未实现）

## 开发

```bash
npm install
npm run dev        # watch 模式
npm run build      # 类型检查 + 产出 index.js
npm run package    # build + 打成 package.zip（思源集市格式）
npm run typecheck  # 仅类型检查
```

调试技巧：把项目根软链到思源工作空间的 `data/plugins/siyuan-inbox-sync/`，每次 `npm run build` 后在思源里 `重新加载`。

## 同步协议

权威文档：[`ThinkPlus/docs/inbox-tech/sync/README.md`](https://github.com/maoruibin/ThinkPlus)（私有）。
跟 Obsidian 端实现完全对齐。

## License

MIT
