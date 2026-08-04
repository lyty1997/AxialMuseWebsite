import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {resolve, sep} from "node:path";

const CANONICAL_REPOSITORY = "lyty1997/AxialMuseWebsite";
const CANONICAL_EVENT = "push";
const CANONICAL_REF = "refs/heads/main";
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_TRACKED_FILES = 8192;
const MAX_TRACKED_PATH_BYTES = 4096;
const CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const UTF8_DECODER = new TextDecoder("utf-8", {fatal: true});

export class ProductionArtifactWorkspaceError extends Error {
  constructor(code) {
    super("production artifact workspace 契约检查失败。");
    this.name = "ProductionArtifactWorkspaceError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: undefined,
      writable: false,
    });
  }
}

function fail(code) {
  throw new ProductionArtifactWorkspaceError(code);
}

function gitEnvironment(environment) {
  const path = typeof environment.PATH === "string" && environment.PATH !== ""
    ? environment.PATH
    : "/usr/bin:/bin";
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    HOME: "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    PATH: path,
  };
}

function decodeGitOutput(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_GIT_OUTPUT_BYTES) {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_GIT");
  }
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_GIT");
  }
}

export function runProductionArtifactGit(
  root,
  arguments_,
  {
    environment = process.env,
    spawnProcess = spawnSync,
  } = {},
) {
  let result;
  try {
    result = spawnProcess("git", arguments_, {
      cwd: root,
      encoding: "buffer",
      env: gitEnvironment(environment),
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      shell: false,
      windowsHide: true,
    });
  } catch {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_GIT");
  }
  if (
    result === null
    || typeof result !== "object"
    || result.error
    || result.signal !== null
    || result.status !== 0
    || !Buffer.isBuffer(result.stdout)
    || !Buffer.isBuffer(result.stderr)
    || result.stderr.length !== 0
  ) {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_GIT");
  }
  return decodeGitOutput(result.stdout);
}

function splitNullRecords(value) {
  if (
    typeof value !== "string"
    || !value.endsWith("\0")
    || value.includes("\r")
  ) {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_GIT");
  }
  return value.slice(0, -1).split("\0");
}

function assertTrackedPath(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_TRACKED_PATH_BYTES
    || value.startsWith("/")
    || value.includes("\\")
    || CONTROL_CHARACTER_PATTERN.test(value)
    || value.split("/").some((segment) => (
      segment.length === 0
      || segment === "."
      || segment === ".."
    ))
  ) {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_GIT");
  }
  return value;
}

function parseHeadTree(value) {
  const records = splitNullRecords(value);
  if (records.length === 0 || records.length > MAX_TRACKED_FILES) {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_GIT");
  }
  const entries = records.map((record) => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(record);
    if (match === null) fail("PRODUCTION_ARTIFACT_WORKSPACE_GIT");
    return Object.freeze({
      mode: match[1],
      objectId: match[2],
      path: assertTrackedPath(match[3]),
    });
  });
  const paths = new Set(entries.map((entry) => entry.path));
  if (paths.size !== entries.length) {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_GIT");
  }
  return Object.freeze(entries);
}

function sourceIdentity(metadata) {
  return Object.freeze({
    changedAtNanoseconds: metadata.ctimeNs,
    device: metadata.dev,
    group: metadata.gid,
    inode: metadata.ino,
    linkCount: metadata.nlink,
    mode: metadata.mode,
    modifiedAtNanoseconds: metadata.mtimeNs,
    owner: metadata.uid,
    size: metadata.size,
  });
}

function sourceIdentitiesEqual(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function normalizePowerShellCheckout(bytes) {
  const normalized = Buffer.allocUnsafe(bytes.length);
  let writeOffset = 0;
  for (let readOffset = 0; readOffset < bytes.length; readOffset += 1) {
    const byte = bytes[readOffset];
    if (byte === 0x0d) {
      if (bytes[readOffset + 1] !== 0x0a) {
        fail("PRODUCTION_ARTIFACT_WORKSPACE_DIRTY");
      }
      normalized[writeOffset] = 0x0a;
      writeOffset += 1;
      readOffset += 1;
    } else {
      if (byte === 0x0a) {
        fail("PRODUCTION_ARTIFACT_WORKSPACE_DIRTY");
      }
      normalized[writeOffset] = byte;
      writeOffset += 1;
    }
  }
  return normalized.subarray(0, writeOffset);
}

function gitBlobObjectId(bytes) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`, "ascii")
    .update(bytes)
    .digest("hex");
}

function captureTrackedPath(root, entry) {
  const path = resolve(root, entry.path);
  let descriptor;
  try {
    const initial = lstatSync(path, {bigint: true});
    const executable = (initial.mode & 0o111n) !== 0n;
    if (
      !path.startsWith(`${root}${sep}`)
      || realpathSync(path) !== path
      || initial.isSymbolicLink()
      || !initial.isFile()
      || initial.nlink !== 1n
      || executable !== (entry.mode === "100755")
    ) {
      fail("PRODUCTION_ARTIFACT_WORKSPACE_DIRTY");
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, {bigint: true});
    if (!sourceIdentitiesEqual(
      sourceIdentity(initial),
      sourceIdentity(opened),
    )) {
      fail("PRODUCTION_ARTIFACT_WORKSPACE_DIRTY");
    }
    const bytes = readFileSync(descriptor);
    const finalDescriptor = fstatSync(descriptor, {bigint: true});
    const finalPath = lstatSync(path, {bigint: true});
    const identity = sourceIdentity(initial);
    if (
      realpathSync(path) !== path
      || !sourceIdentitiesEqual(identity, sourceIdentity(finalDescriptor))
      || !sourceIdentitiesEqual(identity, sourceIdentity(finalPath))
    ) {
      fail("PRODUCTION_ARTIFACT_WORKSPACE_DIRTY");
    }
    let objectId = gitBlobObjectId(bytes);
    if (objectId !== entry.objectId && entry.path.endsWith(".ps1")) {
      objectId = gitBlobObjectId(normalizePowerShellCheckout(bytes));
    }
    if (objectId !== entry.objectId) {
      fail("PRODUCTION_ARTIFACT_WORKSPACE_DIRTY");
    }
    return identity;
  } catch (error) {
    if (error instanceof ProductionArtifactWorkspaceError) throw error;
    fail("PRODUCTION_ARTIFACT_WORKSPACE_DIRTY");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        fail("PRODUCTION_ARTIFACT_WORKSPACE_DIRTY");
      }
    }
  }
}

function assertIndexFlags(entries, value) {
  const records = splitNullRecords(value);
  if (records.length !== entries.length) {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_DIRTY");
  }
  const expectedPaths = new Set(entries.map((entry) => entry.path));
  for (const record of records) {
    const match = /^H (.+)$/u.exec(record);
    if (
      match === null
      || !expectedPaths.delete(assertTrackedPath(match[1]))
    ) {
      fail("PRODUCTION_ARTIFACT_WORKSPACE_DIRTY");
    }
  }
  if (expectedPaths.size !== 0) {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_DIRTY");
  }
}

export function assertProductionArtifactTrackedSource(
  root,
  {
    environment = process.env,
    spawnProcess = spawnSync,
  } = {},
) {
  const runGit = (arguments_) => runProductionArtifactGit(
    root,
    arguments_,
    {environment, spawnProcess},
  );
  const entries = parseHeadTree(runGit([
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    "HEAD",
  ]));
  assertIndexFlags(entries, runGit(["ls-files", "-v", "-z"]));
  if (
    runGit([
      "diff-index",
      "--cached",
      "--name-only",
      "-z",
      "HEAD",
      "--",
    ]) !== ""
  ) {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_DIRTY");
  }
  const initialIdentities = entries.map((entry) => (
    captureTrackedPath(root, entry)
  ));
  for (const [index, entry] of entries.entries()) {
    const current = captureTrackedPath(root, entry);
    if (!sourceIdentitiesEqual(initialIdentities[index], current)) {
      fail("PRODUCTION_ARTIFACT_WORKSPACE_DIRTY");
    }
  }
  return Object.freeze({
    fileCount: entries.length,
  });
}

function oneLine(value, code) {
  if (
    typeof value !== "string"
    || !value.endsWith("\n")
    || value.slice(0, -1).includes("\n")
    || value.includes("\r")
    || value.includes("\0")
  ) {
    fail(code);
  }
  return value.slice(0, -1);
}

function assertCanonicalRoot(root, cwd) {
  try {
    const metadata = lstatSync(root);
    if (
      resolve(root) !== root
      || realpathSync(root) !== root
      || realpathSync(cwd) !== root
      || metadata.isSymbolicLink()
      || !metadata.isDirectory()
    ) {
      fail("PRODUCTION_ARTIFACT_WORKSPACE_ROOT");
    }
  } catch (error) {
    if (error instanceof ProductionArtifactWorkspaceError) throw error;
    fail("PRODUCTION_ARTIFACT_WORKSPACE_ROOT");
  }
}

function pathExistsAsAnyObject(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail("PRODUCTION_ARTIFACT_WORKSPACE_OUTPUT");
  }
}

function assertNoPreexistingOutput(root) {
  if (
    pathExistsAsAnyObject(resolve(root, "build"))
    || pathExistsAsAnyObject(resolve(root, "dist"))
  ) {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_OUTPUT");
  }
}

export function checkProductionArtifactWorkspace({
  root,
  cwd = process.cwd(),
  environment = process.env,
  spawnProcess = spawnSync,
} = {}) {
  if (
    environment === null
    || typeof environment !== "object"
    || Array.isArray(environment)
  ) {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_INPUT");
  }
  const expectedSha = environment.GITHUB_SHA;
  if (typeof expectedSha !== "string" || !/^[0-9a-f]{40}$/u.test(expectedSha)) {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_SHA");
  }
  if (
    environment.GITHUB_REPOSITORY !== CANONICAL_REPOSITORY
    || environment.GITHUB_EVENT_NAME !== CANONICAL_EVENT
    || environment.GITHUB_REF !== CANONICAL_REF
  ) {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_EVENT");
  }
  assertCanonicalRoot(root, cwd);
  const runGit = (arguments_) => runProductionArtifactGit(root, arguments_, {
    environment,
    spawnProcess,
  });
  if (
    oneLine(
      runGit(["rev-parse", "--show-toplevel"]),
      "PRODUCTION_ARTIFACT_WORKSPACE_GIT",
    ) !== root
    || oneLine(
      runGit(["rev-parse", "--is-inside-work-tree"]),
      "PRODUCTION_ARTIFACT_WORKSPACE_GIT",
    ) !== "true"
    || oneLine(
      runGit(["rev-parse", "--is-bare-repository"]),
      "PRODUCTION_ARTIFACT_WORKSPACE_GIT",
    ) !== "false"
  ) {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_GIT");
  }
  if (
    oneLine(
      runGit(["rev-parse", "--is-shallow-repository"]),
      "PRODUCTION_ARTIFACT_WORKSPACE_GIT",
    ) !== "false"
  ) {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_SHALLOW");
  }
  const headSha = oneLine(
    runGit(["rev-parse", "--verify", "HEAD^{commit}"]),
    "PRODUCTION_ARTIFACT_WORKSPACE_GIT",
  );
  if (headSha !== expectedSha) {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_SHA");
  }
  assertProductionArtifactTrackedSource(root, {
    environment,
    spawnProcess,
  });
  assertNoPreexistingOutput(root);
  const status = runGit([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignored=matching",
  ]);
  if (status !== "") {
    fail("PRODUCTION_ARTIFACT_WORKSPACE_DIRTY");
  }
  return Object.freeze({
    commitSha: headSha,
    repository: CANONICAL_REPOSITORY,
  });
}

export function formatProductionArtifactWorkspaceError(error) {
  const code = error instanceof ProductionArtifactWorkspaceError
    && /^PRODUCTION_ARTIFACT_WORKSPACE_[A-Z_]{2,64}$/u.test(error.code)
    ? error.code
    : "PRODUCTION_ARTIFACT_WORKSPACE_INTERNAL";
  return `[${code}] production artifact workspace 未通过。`;
}
