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

export function listFiles(root, predicate = () => true) {
  const files = [];
  const ignoredDirectories = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);

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

