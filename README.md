# siyuan-inbox-sync

把 inBox 云端笔记单向同步到思源笔记。支持 WebDAV / S3 数据源、增量同步、图片/录音/附件、批注、盒子。

## 状态

开发中。

## 设计文档

详见 `/Users/gudong/.claude/plans/splendid-cooking-dragon.md`。

同步协议权威文档：`/Users/gudong/code/workpace/ReProject/ThinkPlus/docs/inbox-tech/sync/README.md`。

## 开发

```bash
pnpm install   # 或 npm install
pnpm run dev   # watch 模式
pnpm run build # 产出 index.js
```

构建产物（`index.js` + `plugin.json` + `i18n/` + `icon.png`）复制到思源工作空间的 `data/plugins/siyuan-inbox-sync/` 即可加载。
