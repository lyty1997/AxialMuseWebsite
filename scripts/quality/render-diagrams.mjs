import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { compilePlantumlToSvg, findAllPlantumlBlocks } from "./lib/plantuml.mjs";
import { projectRoot } from "./lib/files.mjs";

// 用法：
//   node scripts/quality/render-diagrams.mjs            # 生成/刷新模式（写文件）
//
// 只处理"```plantuml 代码块 紧跟着 ![](path.svg) 图片引用"这种配对——没有配图片引用的代码块
// 视为尚未决定渲染产物落地路径，跳过，交给 check-diagrams.mjs 保证它至少能编译。
//
// 注意：这里只负责"把 plantuml 源码渲染成 SVG 落地"，不做任何"已提交 SVG 是否最新"的校验。
// 原因：PlantUML 的 SVG 字节不仅依赖版本，还依赖运行环境的 JVM 字体度量（textLength/坐标/整图尺寸
// 都是按字体 metrics 反推的），同一份源码在不同机器上渲染出的字节并不相同，任何"字节相等"的新鲜度
// 门禁都无法跨机器稳定通过。真相源是 markdown 里的 plantuml 源码，由 check-diagrams.mjs 保证它能编译；
// SVG 只是给 GitHub 这类不渲染 ```plantuml 的平台看的产物，改完源码本地跑一次本脚本刷新并提交即可。
const ROOT = projectRoot();

const jar = process.env.PUML_JAR;
if (!jar) {
  console.error("未设置 PUML_JAR 环境变量。请 export PUML_JAR=/path/to/plantuml.jar 后重试。");
  process.exit(1);
}

const jobs = findAllPlantumlBlocks(ROOT).filter((job) => job.imagePath);

if (jobs.length === 0) {
  console.log("未发现任何带 ![]() 图片引用的 plantuml 图表，无需渲染。");
  process.exit(0);
}

const written = [];
const errors = [];

for (const job of jobs) {
  const relMd = relative(ROOT, job.path).replaceAll("\\", "/");
  const relImg = relative(ROOT, job.imagePath).replaceAll("\\", "/");
  const compiled = compilePlantumlToSvg(jar, job.text);

  if (!compiled.ok) {
    errors.push(`${relMd}:${job.line}: PlantUML 编译失败\n${compiled.error}`);
    continue;
  }

  // 内容一致就跳过，避免无意义地重写文件（时间戳变化）。
  const existing = existsSync(job.imagePath) ? readFileSync(job.imagePath, "utf8") : null;
  if (existing === compiled.svg) {
    continue;
  }

  mkdirSync(dirname(job.imagePath), { recursive: true });
  writeFileSync(job.imagePath, compiled.svg, "utf8");
  written.push(relImg);
}

if (errors.length > 0) {
  console.error(`Diagram rendering failed (${errors.length}/${jobs.length}):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

if (written.length > 0) {
  console.log(`已更新 ${written.length} 个渲染产物：`);
  for (const path of written) {
    console.log(`- ${path}`);
  }
} else {
  console.log(`所有 ${jobs.length} 个渲染产物均已是最新，无需更新。`);
}
