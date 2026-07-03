import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { listFiles, projectRoot, readText } from "./lib/files.mjs";

const ROOT = projectRoot();
const DOCS_ROOT = resolve(ROOT, "docs");
const SKIP_PREFIXES = ["#", "http://", "https://", "mailto:", "tel:"];

function markdownFiles() {
  return listFiles(ROOT, (path) => path.endsWith(".md"));
}

function scanLinkTargets(line) {
  const targets = [];
  let index = 0;

  while (index < line.length) {
    const labelStart = line.indexOf("[", index);
    if (labelStart === -1) break;
    if (labelStart > 0 && line[labelStart - 1] === "!") {
      index = labelStart + 1;
      continue;
    }

    const labelEnd = line.indexOf("]", labelStart + 1);
    if (labelEnd === -1 || line[labelEnd + 1] !== "(") {
      index = labelStart + 1;
      continue;
    }

    const targetStart = labelEnd + 2;
    let targetEnd = targetStart;
    let depth = 0;
    let escaped = false;

    while (targetEnd < line.length) {
      const char = line[targetEnd];
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      targetEnd += 1;
    }

    if (targetEnd < line.length) {
      targets.push(line.slice(targetStart, targetEnd));
      index = targetEnd + 1;
    } else {
      index = targetStart;
    }
  }

  return targets;
}

function normalizeTarget(rawTarget) {
  let target = rawTarget.trim();
  if (!target || SKIP_PREFIXES.some((prefix) => target.startsWith(prefix))) {
    return "";
  }
  if (target.includes(" ") && !target.startsWith("<")) {
    target = target.split(" ", 1)[0];
  }
  target = target.replace(/^<|>$/g, "");
  target = target.split("#", 1)[0].split("?", 1)[0];
  return decodeURIComponent(target);
}

function checkInternalLinks() {
  const errors = [];

  for (const markdownPath of markdownFiles()) {
    const text = readText(markdownPath);
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const rawTarget of scanLinkTargets(line)) {
        const target = normalizeTarget(rawTarget);
        if (!target) continue;

        const resolvedTarget = resolve(resolve(markdownPath, ".."), target);
        const relativeTarget = relative(ROOT, resolvedTarget);
        if (relativeTarget.startsWith("..")) {
          errors.push(`${markdownPath}:${index + 1}: link escapes repo: ${rawTarget}`);
          continue;
        }
        if (!existsSync(resolvedTarget)) {
          errors.push(`${markdownPath}:${index + 1}: broken internal link: ${rawTarget}`);
        }
      }
    }
  }

  return errors;
}

function checkDocsReadmeIndexesAllDocs() {
  const readmePath = resolve(DOCS_ROOT, "README.md");
  if (!existsSync(readmePath)) {
    return ["docs/README.md does not exist"];
  }

  const readmeText = readFileSync(readmePath, "utf8");
  const errors = [];

  for (const docPath of listFiles(DOCS_ROOT, (path) => path.endsWith(".md"))) {
    if (docPath === readmePath) continue;
    const relativePath = relative(DOCS_ROOT, docPath).replaceAll("\\", "/");
    if (!readmeText.includes(relativePath)) {
      errors.push(`docs/README.md does not index docs/${relativePath}`);
    }
  }

  return errors;
}

const errors = [...checkInternalLinks(), ...checkDocsReadmeIndexesAllDocs()];

if (errors.length > 0) {
  console.error("Markdown documentation checks failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Markdown documentation checks passed.");

