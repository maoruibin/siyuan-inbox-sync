import { Dialog, showMessage } from "siyuan";
import type InboxSyncPlugin from "../index";
import { fetchNotebooks } from "../index";

interface NotebookOption {
  id: string;
  name: string;
}

/**
 * 设置对话框
 * 思源插件没有像 Obsidian 那样的 Setting API，自己用 Dialog 实现
 */
export async function openSettingsDialog(plugin: InboxSyncPlugin): Promise<void> {
  const s = plugin.settings;
  const notebooks = await safeFetchNotebooks();

  const html = `
<div class="b3-dialog__content" style="padding: 16px 24px;">
  <div class="ft__smaller ft__on-surface" style="margin-bottom: 12px;">存储类型</div>
  <select id="inbox-storage-type" class="b3-select fn__block" style="margin-bottom: 16px;">
    <option value="webdav" ${s.storageType === "webdav" ? "selected" : ""}>WebDAV</option>
    <option value="s3" ${s.storageType === "s3" ? "selected" : ""}>S3</option>
  </select>

  <div id="inbox-webdav-section">
    <div class="ft__smaller ft__on-surface">WebDAV URL</div>
    <input class="b3-text-field fn__block" id="inbox-webdav-url" value="${escapeAttr(s.webdavUrl)}" placeholder="https://dav.example.com/" />

    <div class="ft__smaller ft__on-surface" style="margin-top: 8px;">用户名</div>
    <input class="b3-text-field fn__block" id="inbox-webdav-username" value="${escapeAttr(s.webdavUsername)}" />

    <div class="ft__smaller ft__on-surface" style="margin-top: 8px;">密码</div>
    <input class="b3-text-field fn__block" type="password" id="inbox-webdav-password" value="${escapeAttr(s.webdavPassword)}" />
  </div>

  <div id="inbox-s3-section">
    <div class="ft__smaller ft__on-surface">Endpoint</div>
    <input class="b3-text-field fn__block" id="inbox-s3-endpoint" value="${escapeAttr(s.s3Endpoint)}" placeholder="https://s3.example.com" />

    <div class="ft__smaller ft__on-surface" style="margin-top: 8px;">Access Key</div>
    <input class="b3-text-field fn__block" id="inbox-s3-access-key" value="${escapeAttr(s.s3AccessKey)}" />

    <div class="ft__smaller ft__on-surface" style="margin-top: 8px;">Secret Key</div>
    <input class="b3-text-field fn__block" type="password" id="inbox-s3-secret-key" value="${escapeAttr(s.s3SecretKey)}" />

    <div class="ft__smaller ft__on-surface" style="margin-top: 8px;">Bucket</div>
    <input class="b3-text-field fn__block" id="inbox-s3-bucket" value="${escapeAttr(s.s3Bucket)}" />

    <div class="ft__smaller ft__on-surface" style="margin-top: 8px;">Region</div>
    <input class="b3-text-field fn__block" id="inbox-s3-region" value="${escapeAttr(s.s3Region)}" />
  </div>

  <div class="ft__smaller ft__on-surface" style="margin-top: 16px;">云端根目录</div>
  <input class="b3-text-field fn__block" id="inbox-cloud-root" value="${escapeAttr(s.cloudRootPath)}" placeholder="inBox" />
  <div class="ft__smaller ft__on-surface b3-chip b3-chip--info" style="margin-top: 4px;">默认 inBox，调试可改 inBoxDebug（需直接改 data.json）</div>

  <hr style="margin: 20px 0; border: none; border-top: 1px solid var(--b3-theme-background-light);" />

  <div class="ft__smaller ft__on-surface">目标笔记本</div>
  <select id="inbox-notebook" class="b3-select fn__block">
    <option value="">（未选择）</option>
    ${notebooks.map((nb) => `<option value="${nb.id}" ${nb.id === s.siyuanNotebookId ? "selected" : ""}>${escapeText(nb.name)}</option>`).join("")}
  </select>

  <div class="ft__smaller ft__on-surface" style="margin-top: 8px;">笔记本下子路径</div>
  <input class="b3-text-field fn__block" id="inbox-base-path" value="${escapeAttr(s.siyuanBasePath)}" placeholder="/inBox（留空=笔记本根）" />

  <hr style="margin: 20px 0; border: none; border-top: 1px solid var(--b3-theme-background-light);" />

  <label class="fn__flex" style="align-items: center; margin-bottom: 12px;">
    <input type="checkbox" id="inbox-auto-sync" ${s.enableAutoSync ? "checked" : ""} style="margin-right: 8px;" />
    <span>启用自动同步</span>
  </label>
  <div class="ft__smaller ft__on-surface">同步间隔（分钟）</div>
  <input class="b3-text-field fn__block" type="number" min="1" id="inbox-sync-interval" value="${s.syncInterval}" />

  <div style="margin-top: 24px; display: flex; gap: 8px; justify-content: flex-end;">
    <button class="b3-button b3-button--outline" id="inbox-test-conn">测试连接</button>
    <button class="b3-button b3-button--text" id="inbox-cancel">取消</button>
    <button class="b3-button b3-button--outline" id="inbox-save">保存</button>
  </div>
</div>
`;

  const dialog = new Dialog({
    title: "inBox 同步设置",
    content: html,
    width: "600px",
  });

  const root = dialog.element;

  // 切换可见性
  const updateSectionVisibility = () => {
    const type = (root.querySelector("#inbox-storage-type") as HTMLSelectElement).value;
    root.querySelector("#inbox-webdav-section")?.setAttribute("style", type === "webdav" ? "" : "display:none");
    root.querySelector("#inbox-s3-section")?.setAttribute("style", type === "s3" ? "" : "display:none");
  };
  root.querySelector("#inbox-storage-type")?.addEventListener("change", updateSectionVisibility);
  updateSectionVisibility();

  // 取消
  root.querySelector("#inbox-cancel")?.addEventListener("click", () => dialog.destroy());

  // 保存
  root.querySelector("#inbox-save")?.addEventListener("click", async () => {
    const next = collectForm(root);
    await plugin.updateSettings(next);
    showMessage("设置已保存", 2000, "info");
    dialog.destroy();
  });

  // 测试连接
  root.querySelector("#inbox-test-conn")?.addEventListener("click", async () => {
    const btn = root.querySelector("#inbox-test-conn") as HTMLButtonElement;
    const original = btn.textContent;
    btn.textContent = "测试中...";
    btn.disabled = true;

    const next = collectForm(root);
    await plugin.updateSettings(next);

    try {
      const result = await plugin.syncManager?.testConnection();
      if (result?.success) {
        showMessage("连接成功", 3000, "info");
      } else {
        showMessage(`连接失败：${result?.error ?? "未知错误"}`, 5000, "error");
      }
      void result;
    } catch (err) {
      showMessage(`连接失败：${err instanceof Error ? err.message : String(err)}`, 5000, "error");
    } finally {
      btn.textContent = original;
      btn.disabled = false;
    }
  });
}

function collectForm(root: HTMLElement): Partial<InboxSyncPlugin["settings"]> {
  const get = (id: string) => (root.querySelector(`#${id}`) as HTMLInputElement | null)?.value ?? "";
  const getChecked = (id: string) => (root.querySelector(`#${id}`) as HTMLInputElement | null)?.checked ?? false;
  const getNumber = (id: string) => Number(get(id)) || 0;

  return {
    storageType: get("inbox-storage-type") as "webdav" | "s3",
    webdavUrl: get("inbox-webdav-url"),
    webdavUsername: get("inbox-webdav-username"),
    webdavPassword: get("inbox-webdav-password"),
    s3Endpoint: get("inbox-s3-endpoint"),
    s3AccessKey: get("inbox-s3-access-key"),
    s3SecretKey: get("inbox-s3-secret-key"),
    s3Bucket: get("inbox-s3-bucket"),
    s3Region: get("inbox-s3-region"),
    cloudRootPath: get("inbox-cloud-root"),
    siyuanNotebookId: get("inbox-notebook"),
    siyuanBasePath: get("inbox-base-path"),
    enableAutoSync: getChecked("inbox-auto-sync"),
    syncInterval: getNumber("inbox-sync-interval"),
  };
}

async function safeFetchNotebooks(): Promise<NotebookOption[]> {
  try {
    return await fetchNotebooks();
  } catch (err) {
    console.warn("[Settings] 加载笔记本列表失败:", err);
    return [];
  }
}

function escapeAttr(s: string): string {
  return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(s: string): string {
  return String(s ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
