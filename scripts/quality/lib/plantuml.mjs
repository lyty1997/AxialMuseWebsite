import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { listFiles, readText } from "./files.mjs";

// 提取一个 markdown 文件里所有 ```plantuml 代码块，以及紧跟其后（允许中间隔一个空行）
// 的第一个 markdown 图片引用 ![alt](target)，作为该图表渲染产物的落地路径。
// 没有紧跟图片引用的代码块 imagePath 为 null——按约定视为"仅要求能编译，不要求落地渲染产物"。
const IMAGE_LINK = /^\s*!\[[^\]]*\]\(([^)]+)\)\s*$/;

export function findPlantumlBlocks(markdownPath) {
  const text = readText(markdownPath);
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let inBlock = false;
  let current = [];
  let startLine = 0;
  let fenceEndIndex = -1;

  for (const [index, line] of lines.entries()) {
    if (!inBlock && /^\s*```plantuml\s*$/.test(line)) {
      inBlock = true;
      current = [];
      startLine = index + 1;
      continue;
    }
    if (inBlock && /^\s*```\s*$/.test(line)) {
      inBlock = false;
      fenceEndIndex = index;
      blocks.push({ text: current.join("\n"), line: startLine, fenceEndIndex });
      continue;
    }
    if (inBlock) {
      current.push(line);
    }
  }

  for (const block of blocks) {
    let imagePath = null;
    for (let offset = 1; offset <= 2; offset += 1) {
      const candidate = lines[block.fenceEndIndex + offset];
      if (candidate === undefined) break;
      if (candidate.trim() === "") continue;
      const match = IMAGE_LINK.exec(candidate);
      if (match) {
        imagePath = resolve(markdownPath, "..", match[1]);
      }
      break;
    }
    block.imagePath = imagePath;
    delete block.fenceEndIndex;
  }

  return blocks;
}

export function findAllPlantumlBlocks(root) {
  const jobs = [];
  for (const path of listFiles(root, (p) => p.endsWith(".md"))) {
    for (const block of findPlantumlBlocks(path)) {
      jobs.push({ path, ...block });
    }
  }
  return jobs;
}

// 编译单个 plantuml 源码块为 SVG，返回 { ok, svg, error }。
export function compilePlantumlToSvg(jar, source) {
  const result = spawnSync("java", ["-jar", jar, "-failfast2", "-pipe", "-tsvg"], {
    input: source,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 32
  });

  if (result.error) {
    return { ok: false, error: `无法执行 java（${result.error.message}）` };
  }
  // 只认退出码：stderr 可能混入 JVM 首次运行的无害提示（如 "Created user preferences directory"），
  // 不能作为失败判据，否则会把干净编译误判为失败。
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr ?? "").trim() || `exit=${result.status}` };
  }
  return { ok: true, svg: result.stdout };
}
