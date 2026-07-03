import { relative } from "node:path";
import { listFiles, projectRoot, readText } from "./lib/files.mjs";

const ROOT = projectRoot();
const SECRET_PATTERNS = [
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "GitHub token", pattern: /gh[pousr]_[0-9A-Za-z_]{36,}/ },
  { name: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "generic secret assignment", pattern: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{16,}["']/i }
];

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".txt",
  ".yaml",
  ".yml"
]);

function extensionOf(path) {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index);
}

const errors = [];
for (const filePath of listFiles(ROOT, (path) => TEXT_EXTENSIONS.has(extensionOf(path)))) {
  const relativePath = relative(ROOT, filePath).replaceAll("\\", "/");
  if (relativePath.startsWith(".git/") || relativePath.startsWith("node_modules/")) {
    continue;
  }
  const lines = readText(filePath).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.includes("pragma: allowlist secret")) continue;
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        errors.push(`${filePath}:${index + 1}: possible ${name}`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error("Secret scan failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Secret scan passed.");

