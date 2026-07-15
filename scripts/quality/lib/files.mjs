import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function projectRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function readText(path) {
  return readFileSync(path, "utf8");
}

export function readJson(path) {
  return JSON.parse(readText(path));
}

// 只列出 directory 一层内的文件，不递归子目录。
// 用于扫描仓库根级文件：根目录下混有 .mypy_cache、.docusaurus 这类本地工具缓存，
// 它们由自带的嵌套 .gitignore 对 git 隐身、却对文件系统可见，递归会把它们卷进门禁，
// 让扫描范围随各人机器上的残留而变；只扫一层则天然排除所有目录，无需维护排除名单。
export function listFilesShallow(directory, predicate = () => true) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = resolve(directory, entry.name);
    if (predicate(path)) files.push(path);
  }
  return files.sort();
}

export function listFiles(root, predicate = () => true) {
  const files = [];
  const ignoredDirectories = new Set([
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "coverage",
    ".venv",
    "venv",
    "__pycache__"
  ]);

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          walk(resolve(directory, entry.name));
        }
        continue;
      }

      const path = resolve(directory, entry.name);
      if (entry.isFile() && predicate(path)) {
        files.push(path);
      }
    }
  }

  walk(root);
  return files.sort();
}

