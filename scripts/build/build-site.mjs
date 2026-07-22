import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {extname, join, relative, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {randomBytes} from "node:crypto";
import {spawnSync} from "node:child_process";
import {projectRoot} from "../quality/lib/files.mjs";
import {buildQualityChildEnvironment} from "../quality/lib/process-environment.mjs";
import {
  readAndValidateManifest,
  readAndValidateRuntimeContract,
} from "../quality/lib/supply-chain/config.mjs";

const ROOT = projectRoot();
const OWNER_FILE_NAME = ".axial-muse-build-owner";
const ALLOWED_BASELINE_FILES = new Set([
  "projects/.gitkeep",
  "writing/.gitkeep",
]);

export class BuildSiteError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "BuildSiteError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new BuildSiteError(code, message, options);
}

export function formatBuildSiteError(error) {
  if (error instanceof BuildSiteError) {
    return `[${error.code}] ${error.message}`;
  }
  return "[BUILD_INTERNAL] 构建入口发生未分类错误；详细堆栈已抑制，避免泄露本机路径或环境信息。";
}

export function parseBuildArguments(arguments_) {
  if (
    !Array.isArray(arguments_)
    || arguments_.length !== 2
    || arguments_[0] !== "--mode"
  ) {
    fail("BUILD_ARGUMENTS", "构建入口只接受 --mode <mode>。");
  }
  if (arguments_[1] === "preview") {
    fail("BUILD_MODE_UNAVAILABLE", "preview 构建由 #8 接管前保持失败关闭。");
  }
  if (arguments_[1] !== "production") {
    fail("BUILD_MODE", "未知构建模式。");
  }
  return Object.freeze({mode: "production"});
}

export function assertSupportedNodeVersion({
  root = ROOT,
  nodeVersion = process.versions.node,
} = {}) {
  const manifest = readAndValidateManifest(root);
  const contract = readAndValidateRuntimeContract({root, manifest});
  const role = Object.entries(contract.nodeVersionsByRole)
    .find(([, version]) => version === nodeVersion)?.[0];
  if (role === undefined) {
    fail("BUILD_RUNTIME_NODE", "当前 Node 不属于 .nvmrc 主端点或 engines 下界端点。");
  }
  return role;
}

function listBaselineContentFiles(root) {
  const contentRoot = resolve(root, "site-content");
  if (!existsSync(contentRoot) || !lstatSync(contentRoot).isDirectory()) {
    fail("BUILD_CONTENT_ROOT", "site-content 物理内容根缺失。");
  }
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail("BUILD_CONTENT_LINK", "I-04 内容根不得包含符号链接。");
      }
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        files.push(relative(contentRoot, path).replaceAll("\\", "/"));
      } else {
        fail("BUILD_CONTENT_ENTRY", "I-04 内容根包含不受支持的文件类型。");
      }
    }
  };
  walk(contentRoot);
  return files.sort();
}

export function assertBaselineInputs(root = ROOT) {
  for (const path of ["static", "static-public", "site-assets"]) {
    if (existsSync(resolve(root, path))) {
      fail(
        "BUILD_PIPELINE_INCOMPLETE",
        "发布素材管线由 #7 接管前不得静默忽略静态源目录。",
      );
    }
  }
  const files = listBaselineContentFiles(root);
  if (
    files.length !== ALLOWED_BASELINE_FILES.size
    || files.some((path) => !ALLOWED_BASELINE_FILES.has(path))
  ) {
    fail(
      "BUILD_PIPELINE_INCOMPLETE",
      "内容校验由 #23 接管前不得构建真实 Markdown/MDX 或其他内容成员。",
    );
  }
  if (files.some((path) => [".md", ".mdx"].includes(extname(path)))) {
    fail("BUILD_PIPELINE_INCOMPLETE", "I-04 基线不得发布真实内容。");
  }
}

function resolveDocusaurusCli(root) {
  const require = createRequire(import.meta.url);
  let cliPath;
  try {
    cliPath = require.resolve("@docusaurus/core/bin/docusaurus.mjs", {
      paths: [root],
    });
  } catch (error) {
    fail("BUILD_DEPENDENCIES", "本地冻结的 Docusaurus CLI 不可用。", {cause: error});
  }
  const expectedPackageRoot = realpathSync(
    resolve(root, "node_modules", "@docusaurus", "core"),
  );
  const realCliPath = realpathSync(cliPath);
  const relativeCliPath = relative(expectedPackageRoot, realCliPath);
  if (
    relativeCliPath === ""
    || relativeCliPath.startsWith("..")
    || resolve(expectedPackageRoot, relativeCliPath) !== realCliPath
    || !lstatSync(realCliPath).isFile()
  ) {
    fail("BUILD_DEPENDENCIES", "Docusaurus CLI 逃逸已冻结的本地包目录。");
  }
  return realCliPath;
}

function createBuildContext() {
  const temporaryRoot = realpathSync(tmpdir());
  const buildRoot = mkdtempSync(join(temporaryRoot, "axial-muse-build-"));
  chmodSync(buildRoot, 0o700);
  const staticDirectory = resolve(buildRoot, "static");
  mkdirSync(staticDirectory, {mode: 0o700});
  chmodSync(staticDirectory, 0o700);
  const owner = randomBytes(32).toString("hex");
  const ownerPath = resolve(buildRoot, OWNER_FILE_NAME);
  writeFileSync(ownerPath, `${owner}\n`, {encoding: "utf8", flag: "wx", mode: 0o600});
  chmodSync(ownerPath, 0o600);
  return {buildRoot, owner};
}

export function runProductionBuild({root = ROOT} = {}) {
  assertSupportedNodeVersion({root});
  assertBaselineInputs(root);
  const cliPath = resolveDocusaurusCli(root);
  const context = createBuildContext();
  let result;
  let cleanupError;
  try {
    result = spawnSync(process.execPath, [cliPath, "build"], {
      cwd: root,
      env: {
        ...buildQualityChildEnvironment(),
        NODE_ENV: "production",
        DOCUSAURUS_NO_PERSISTENT_CACHE: "1",
        AXIAL_MUSE_BUILD_MODE: "production",
        AXIAL_MUSE_BUILD_ROOT: context.buildRoot,
        AXIAL_MUSE_BUILD_OWNER: context.owner,
      },
      stdio: "inherit",
    });
  } finally {
    try {
      rmSync(context.buildRoot, {recursive: true, force: false});
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError !== undefined) {
    fail("BUILD_CLEANUP", "临时构建上下文清理失败。", {cause: cleanupError});
  }
  if (result?.error || result?.signal || result?.status !== 0) {
    fail("BUILD_DOCUSARUS", "Docusaurus production build 失败。", {
      cause: result?.error,
    });
  }
}

function runCli() {
  try {
    parseBuildArguments(process.argv.slice(2));
    runProductionBuild();
  } catch (error) {
    console.error(formatBuildSiteError(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}
