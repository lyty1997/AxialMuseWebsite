import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoot, readText } from "./lib/files.mjs";

const ROOT = projectRoot();
const INDEX_PATH = resolve(ROOT, "public/index.html");
const errors = [];

if (!existsSync(INDEX_PATH)) {
  errors.push("public/index.html does not exist");
} else {
  const html = readText(INDEX_PATH);
  const requiredSnippets = [
    '<html lang="zh-CN">',
    "<title>Axial Muse</title>",
    'href="./styles.css"',
    'id="projects"',
    'id="writing"',
    'id="roadmap"'
  ];

  for (const snippet of requiredSnippets) {
    if (!html.includes(snippet)) {
      errors.push(`public/index.html missing required snippet: ${snippet}`);
    }
  }

  const resourceMatches = html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g);
  for (const match of resourceMatches) {
    const resourcePath = resolve(INDEX_PATH, "..", match[1]);
    if (!existsSync(resourcePath)) {
      errors.push(`public/index.html references missing resource: ${match[1]}`);
    }
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

