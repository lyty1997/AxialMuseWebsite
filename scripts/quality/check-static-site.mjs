import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoot, readJson, readText } from "./lib/files.mjs";

const ROOT = projectRoot();
const CONFIG_PATH = resolve(ROOT, "docs/contracts/site-checks.json");

if (!existsSync(CONFIG_PATH)) {
  console.log("未找到 docs/contracts/site-checks.json，跳过静态站点检查。");
  process.exit(0);
}

const config = readJson(CONFIG_PATH);
const entryPath = resolve(ROOT, config.entryFile);

if (!existsSync(entryPath)) {
  console.log(`未找到 ${config.entryFile}，跳过静态站点检查（尚未搭建对应前端入口）。`);
  process.exit(0);
}

const errors = [];
const html = readText(entryPath);

for (const snippet of config.requiredSnippets ?? []) {
  if (!html.includes(snippet)) {
    errors.push(`${config.entryFile} missing required snippet: ${snippet}`);
  }
}

// 覆盖单/双引号与任意相对路径；跳过绝对 URL（http(s)://、//、data:、mailto: 等）、
// 根相对路径（/... 交给部署时校验）和纯锚点（#...）。
const resourceMatches = html.matchAll(/(?:href|src)\s*=\s*("([^"]+)"|'([^']+)')/gi);
for (const match of resourceMatches) {
  const url = (match[2] ?? match[3] ?? "").trim();
  if (!url) continue;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) continue;
  if (url.startsWith("/")) continue;
  const cleanUrl = url.split(/[?#]/, 1)[0];
  const resourcePath = resolve(entryPath, "..", cleanUrl);
  if (!existsSync(resourcePath)) {
    errors.push(`${config.entryFile} references missing resource: ${url}`);
  }
}

if (errors.length > 0) {
  console.error("Static site checks failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Static site checks passed.");
