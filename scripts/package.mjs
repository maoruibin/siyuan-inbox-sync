/**
 * 打包思源插件为 package.zip
 * 思源集市要求的格式：扁平结构，根目录直接包含 index.js / plugin.json / i18n/ / icon.png / preview.png / README.md
 */
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const ZIP = "package.zip";
const FILES = [
  "index.js",
  "plugin.json",
  "i18n/en_US.json",
  "i18n/zh_CN.json",
  "icon.png",
  "preview.png",
  "README.md",
  "LICENSE",
];

if (existsSync(ZIP)) rmSync(ZIP);

const missing = FILES.filter((f) => !existsSync(f));
if (missing.length > 0) {
  console.error("[package] 缺失文件:", missing.join(", "));
  console.error("请先运行 `npm run build` 生成 index.js");
  process.exit(1);
}

execSync(`zip -X ${ZIP} ${FILES.join(" ")}`, { stdio: "inherit" });

const size = (execSync(`stat -f%z ${ZIP}`).toString().trim());
console.log(`✓ ${ZIP} 已生成 (${(Number(size) / 1024).toFixed(1)} KB)`);
