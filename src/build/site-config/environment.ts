import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {basename, dirname, isAbsolute, resolve} from "node:path";

const BUILD_ROOT_PREFIX = "axial-muse-build-";
const OWNER_FILE_NAME = ".axial-muse-build-owner";
const OWNER_PATTERN = /^[0-9a-f]{64}$/u;

export type BuildMode = "production";

export interface BuildContext {
  readonly mode: BuildMode;
  readonly staticDirectory: string;
}

class BuildContextError extends Error {
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "BuildContextError";
  }
}

function fail(code: string, message: string): never {
  throw new BuildContextError(code, message);
}

function assertPrivateEntry(
  path: string,
  expectedType: "directory" | "file",
  expectedMode: number,
): void {
  const metadata = lstatSync(path);
  const hasExpectedType = expectedType === "directory"
    ? metadata.isDirectory()
    : metadata.isFile();
  if (metadata.isSymbolicLink() || !hasExpectedType) {
    fail("BUILD_CONTEXT_ENTRY", "构建上下文成员类型不合法。");
  }
  const hasAllowedLinkCount = expectedType === "file"
    ? metadata.nlink === 1
    : metadata.nlink >= 1;
  if ((metadata.mode & 0o777) !== expectedMode || !hasAllowedLinkCount) {
    fail("BUILD_CONTEXT_PERMISSION", "构建上下文成员权限或链接数不合法。");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    fail("BUILD_CONTEXT_OWNER", "构建上下文成员不属于当前用户。");
  }
}

export function readBuildContext(
  environment: NodeJS.ProcessEnv = process.env,
): BuildContext {
  if (environment.AXIAL_MUSE_BUILD_MODE !== "production") {
    fail("BUILD_CONTEXT_MODE", "只接受受控 production 构建上下文。");
  }
  const buildRootInput = environment.AXIAL_MUSE_BUILD_ROOT;
  const owner = environment.AXIAL_MUSE_BUILD_OWNER;
  if (
    typeof buildRootInput !== "string"
    || !isAbsolute(buildRootInput)
    || typeof owner !== "string"
    || !OWNER_PATTERN.test(owner)
  ) {
    fail("BUILD_CONTEXT_ENV", "构建上下文环境不完整或格式不合法。");
  }

  assertPrivateEntry(buildRootInput, "directory", 0o700);
  const buildRoot = realpathSync(buildRootInput);
  const temporaryRoot = realpathSync(tmpdir());
  if (
    dirname(buildRoot) !== temporaryRoot
    || !basename(buildRoot).startsWith(BUILD_ROOT_PREFIX)
  ) {
    fail("BUILD_CONTEXT_PATH", "构建上下文不在受控系统临时根内。");
  }

  const entries = readdirSync(buildRoot).sort();
  if (entries.join("\n") !== `${OWNER_FILE_NAME}\nstatic`) {
    fail("BUILD_CONTEXT_MEMBERS", "构建上下文根成员集合不合法。");
  }

  const ownerPath = resolve(buildRoot, OWNER_FILE_NAME);
  const staticDirectory = resolve(buildRoot, "static");
  assertPrivateEntry(ownerPath, "file", 0o600);
  assertPrivateEntry(staticDirectory, "directory", 0o700);
  if (readFileSync(ownerPath, "utf8") !== `${owner}\n`) {
    fail("BUILD_CONTEXT_MARKER", "构建上下文所有权标记不匹配。");
  }

  return Object.freeze({
    mode: "production",
    staticDirectory,
  });
}
