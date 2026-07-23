import {createHash} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import type {BigIntStats} from "node:fs";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import {StaticAssetError, failStaticAsset} from "./errors.js";
import {findSsrImageReferenceIndexes} from "./ssr-html.js";

export const MAX_PROJECT_MEDIA_BYTES = 300_000;
export const MAX_STATIC_PUBLIC_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_UNPUBLISHED_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_SOURCE_FILES = 2_048;
export const MAX_SOURCE_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_SOURCE_DEPTH = 8;
export const MAX_SOURCE_PATH_BYTES = 512;

const MAX_BUILD_FILES = 50_000;
const MAX_BUILD_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BUILD_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_BUILD_DEPTH = 24;
const MAX_BUILD_PATH_BYTES = 1_024;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_BUILD_HTML_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_UNPUBLISHED_PATH_TOKEN_TOTAL_BYTES = 512 * 1024;
const MAX_UNPUBLISHED_PATH_TOKENS = MAX_SOURCE_FILES * 2;
export const MAX_UNPUBLISHED_CONTENT_TOKEN_BYTES = 16 * 1024;
export const MAX_UNPUBLISHED_CONTENT_TOKEN_TOTAL_BYTES = 512 * 1024;
export const MAX_UNPUBLISHED_CONTENT_TOKENS = MAX_SOURCE_FILES * 4;
const READ_CHUNK_BYTES = 64 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", {fatal: true});
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;
const TYPED_ARRAY_TAG = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
)?.get;

export interface BuildFileEvidence {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface BuildTreeEvidence {
  readonly files: readonly BuildFileEvidence[];
  readonly hasLeakedToken: boolean;
  readonly hasLeakedPathToken: boolean;
  readonly hasLeakedContentToken: boolean;
  readonly ssrImageReferenceIndexes: ReadonlySet<number>;
}

interface TokenAutomatonNode {
  readonly transitions: Map<number, number>;
  failure: number;
  isTerminal: boolean;
}

interface TokenAutomaton {
  readonly nodes: readonly TokenAutomatonNode[];
}

interface ScannedArtifact {
  readonly evidence: BuildFileEvidence;
  readonly hasLeakedPathToken: boolean;
  readonly hasLeakedContentToken: boolean;
}

interface TokenLimits {
  readonly maximumCount: number;
  readonly maximumTokenBytes: number;
  readonly maximumTotalBytes: number;
}

function compareBuffers(left: Uint8Array, right: Uint8Array): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export function compareUtf8(left: string, right: string): number {
  return compareBuffers(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compileTokenAutomaton(tokens: readonly Uint8Array[]): TokenAutomaton {
  const nodes: TokenAutomatonNode[] = [{
    transitions: new Map(),
    failure: 0,
    isTerminal: false,
  }];
  for (const token of tokens) {
    let state = 0;
    for (const byte of token) {
      let next = nodes[state].transitions.get(byte);
      if (next === undefined) {
        next = nodes.length;
        nodes[state].transitions.set(byte, next);
        nodes.push({transitions: new Map(), failure: 0, isTerminal: false});
      }
      state = next;
    }
    nodes[state].isTerminal = true;
  }

  const queue: number[] = [];
  for (const child of nodes[0].transitions.values()) queue.push(child);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const state = queue[cursor];
    for (const [byte, child] of nodes[state].transitions) {
      queue.push(child);
      let failure = nodes[state].failure;
      while (failure !== 0 && !nodes[failure].transitions.has(byte)) {
        failure = nodes[failure].failure;
      }
      const fallback = nodes[failure].transitions.get(byte);
      nodes[child].failure = fallback === undefined || fallback === child
        ? 0
        : fallback;
      if (nodes[nodes[child].failure].isTerminal) nodes[child].isTerminal = true;
    }
  }
  return Object.freeze({nodes: Object.freeze(nodes)});
}

function scanTokenChunk(
  automaton: TokenAutomaton,
  initialState: number,
  bytes: Uint8Array,
): Readonly<{state: number; hasMatch: boolean}> {
  let state = initialState;
  let hasMatch = false;
  for (const byte of bytes) {
    while (
      state !== 0
      && !automaton.nodes[state].transitions.has(byte)
    ) state = automaton.nodes[state].failure;
    state = automaton.nodes[state].transitions.get(byte) ?? 0;
    if (automaton.nodes[state].isTerminal) hasMatch = true;
  }
  return {state, hasMatch};
}

function snapshotToken(
  value: unknown,
  maximumTokenBytes: number,
): Uint8Array | undefined {
  let snapshot: Uint8Array | undefined;
  try {
    if (
      typeof TYPED_ARRAY_BYTE_LENGTH !== "function"
      || typeof TYPED_ARRAY_TAG !== "function"
      || !ArrayBuffer.isView(value)
      || Reflect.apply(TYPED_ARRAY_TAG, value, []) !== "Uint8Array"
    ) return undefined;
    const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, value, []) as unknown;
    if (
      !Number.isSafeInteger(byteLength)
      || (byteLength as number) <= 0
      || (byteLength as number) > maximumTokenBytes
    ) return undefined;
    snapshot = new Uint8Array(byteLength as number);
    Uint8Array.prototype.set.call(snapshot, value as Uint8Array);
    return snapshot;
  } catch {
    snapshot?.fill(0);
    return undefined;
  }
}

function snapshotTokens(
  values: unknown,
  limits: TokenLimits,
): readonly Uint8Array[] {
  const snapshots: Uint8Array[] = [];
  try {
    if (!Array.isArray(values) || values.length > limits.maximumCount) {
      failStaticAsset(
        "STATIC_ASSET_UNPUBLISHED_TOKEN",
        "未发布素材 token 的数量或总长度不合法。",
        {sourcePath: "build"},
      );
    }
    let totalBytes = 0;
    for (const value of values) {
      const snapshot = snapshotToken(value, limits.maximumTokenBytes);
      if (
        snapshot === undefined
        || snapshot.byteLength > limits.maximumTokenBytes
      ) {
        failStaticAsset(
          "STATIC_ASSET_UNPUBLISHED_TOKEN",
          "未发布素材 token 的数量或总长度不合法。",
          {sourcePath: "build"},
        );
      }
      totalBytes += snapshot.byteLength;
      if (totalBytes > limits.maximumTotalBytes) {
        snapshot.fill(0);
        failStaticAsset(
          "STATIC_ASSET_UNPUBLISHED_TOKEN",
          "未发布素材 token 的数量或总长度不合法。",
          {sourcePath: "build"},
        );
      }
      snapshots.push(snapshot);
    }
    return Object.freeze(snapshots);
  } catch (error) {
    for (const snapshot of snapshots) snapshot.fill(0);
    if (error instanceof StaticAssetError) throw error;
    failStaticAsset(
      "STATIC_ASSET_UNPUBLISHED_TOKEN",
      "未发布素材 token 的数量或总长度不合法。",
      {cause: error, sourcePath: "build"},
    );
  }
}

function snapshotSsrPublicUrls(values: unknown): readonly string[] {
  try {
    if (!Array.isArray(values) || values.length > MAX_SOURCE_FILES) {
      throw new TypeError("invalid SSR URL collection");
    }
    const snapshots: string[] = [];
    const unique = new Set<string>();
    for (const value of values) {
      if (
        typeof value !== "string"
        || !value.startsWith("/")
        || value.length === 1
        || Buffer.byteLength(value, "utf8") > MAX_SOURCE_PATH_BYTES
        || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
        || unique.has(value)
      ) throw new TypeError("invalid SSR URL");
      unique.add(value);
      snapshots.push(value);
    }
    return Object.freeze(snapshots);
  } catch (error) {
    failStaticAsset(
      "STATIC_ASSET_SSR_REFERENCE_INPUT",
      "SSR 图片引用集合不合法。",
      {cause: error, sourcePath: "build"},
    );
  }
}

export function isPathWithin(realRoot: string, realPath: string): boolean {
  const relation = relative(realRoot, realPath);
  return relation === ""
    || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function assertCurrentOwner(metadata: BigIntStats, sourcePath: string): void {
  if (
    typeof process.getuid === "function"
    && metadata.uid !== BigInt(process.getuid())
  ) {
    failStaticAsset(
      "STATIC_ASSET_SOURCE_OWNER",
      "素材文件必须属于当前构建用户。",
      {sourcePath},
    );
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function rethrowIo(error: unknown, sourcePath: string): never {
  if (error instanceof StaticAssetError) throw error;
  failStaticAsset(
    "STATIC_ASSET_IO",
    "静态素材文件系统操作失败。",
    {cause: error, sourcePath},
  );
}

export function assertDirectory(
  absolutePath: string,
  sourcePath: string,
): string {
  try {
    const metadata = lstatSync(absolutePath, {bigint: true});
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      failStaticAsset(
        "STATIC_ASSET_SOURCE_DIRECTORY",
        "素材目录必须是真实目录且不能是符号链接。",
        {sourcePath},
      );
    }
    assertCurrentOwner(metadata, sourcePath);
    return realpathSync(absolutePath);
  } catch (error) {
    return rethrowIo(error, sourcePath);
  }
}

export function readAsciiDirectoryNames(
  directory: string,
  sourcePath: string,
): readonly string[] {
  try {
    const rawNames = readdirSync(directory, {
      encoding: "buffer",
      withFileTypes: false,
    }) as Buffer[];
    rawNames.sort(Buffer.compare);
    return rawNames.map((rawName) => {
      if (
        rawName.length === 0
        || [...rawName].some((byte) => byte < 0x21 || byte > 0x7e)
      ) {
        failStaticAsset(
          "STATIC_ASSET_SOURCE_PATH",
          "素材源文件名必须是可打印 ASCII。",
          {sourcePath},
        );
      }
      return rawName.toString("ascii");
    });
  } catch (error) {
    return rethrowIo(error, sourcePath);
  }
}

export function readPrivateFileSnapshot({
  absolutePath,
  realRoot,
  sourcePath,
  maximumBytes,
}: Readonly<{
  absolutePath: string;
  realRoot: string;
  sourcePath: string;
  maximumBytes: number;
}>): Uint8Array {
  let descriptor: number | undefined;
  let operationError: unknown;
  let snapshot: Uint8Array | undefined;
  try {
    const before = lstatSync(absolutePath, {bigint: true});
    if (before.isSymbolicLink() || !before.isFile()) {
      failStaticAsset(
        "STATIC_ASSET_SOURCE_FILE_TYPE",
        "素材源必须是普通文件且不能是符号链接。",
        {sourcePath},
      );
    }
    if (before.nlink !== 1n) {
      failStaticAsset(
        "STATIC_ASSET_SOURCE_HARDLINK",
        "素材源普通文件不能有额外硬链接。",
        {sourcePath},
      );
    }
    assertCurrentOwner(before, sourcePath);
    if (before.size > BigInt(maximumBytes)) {
      failStaticAsset(
        "STATIC_ASSET_SOURCE_SIZE",
        "素材源在读取和分配前超过固定字节上限。",
        {sourcePath},
      );
    }
    const realBefore = realpathSync(absolutePath);
    if (!isPathWithin(realRoot, realBefore)) {
      failStaticAsset(
        "STATIC_ASSET_SOURCE_ESCAPE",
        "素材源真实路径逃逸预期根目录。",
        {sourcePath},
      );
    }
    if (
      typeof constants.O_NOFOLLOW !== "number"
      || typeof constants.O_NONBLOCK !== "number"
    ) {
      failStaticAsset(
        "STATIC_ASSET_RUNTIME_FLAGS",
        "当前 Linux 运行时不提供安全打开素材所需的文件标志。",
        {sourcePath},
      );
    }
    descriptor = openSync(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(descriptor, {bigint: true});
    if (
      !opened.isFile()
      || opened.nlink !== 1n
      || !sameFileIdentity(before, opened)
    ) {
      failStaticAsset(
        "STATIC_ASSET_SOURCE_IDENTITY",
        "素材源在安全打开前后发生身份漂移。",
        {sourcePath},
      );
    }
    const length = Number(opened.size);
    snapshot = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(descriptor, snapshot, offset, length - offset, offset);
      if (count <= 0) {
        failStaticAsset(
          "STATIC_ASSET_SOURCE_READ",
          "素材源没有产生登记大小的完整字节快照。",
          {sourcePath},
        );
      }
      offset += count;
    }
    const afterRead = fstatSync(descriptor, {bigint: true});
    const afterPath = lstatSync(absolutePath, {bigint: true});
    const realAfter = realpathSync(absolutePath);
    if (
      !sameFileIdentity(opened, afterRead)
      || !sameFileIdentity(opened, afterPath)
      || realAfter !== realBefore
      || !isPathWithin(realRoot, realAfter)
    ) {
      failStaticAsset(
        "STATIC_ASSET_SOURCE_IDENTITY",
        "素材源在读取期间发生身份或路径漂移。",
        {sourcePath},
      );
    }
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  if (closeError !== undefined) {
    snapshot?.fill(0);
    failStaticAsset(
      "STATIC_ASSET_SOURCE_CLOSE",
      "素材源文件描述符关闭失败。",
      {cause: closeError, sourcePath},
    );
  }
  if (operationError !== undefined) {
    snapshot?.fill(0);
    rethrowIo(operationError, sourcePath);
  }
  if (snapshot === undefined) {
    failStaticAsset(
      "STATIC_ASSET_SOURCE_READ",
      "素材源未产生字节快照。",
      {sourcePath},
    );
  }
  return snapshot;
}

function decodeBuildName(rawName: Buffer, parentPath: string): string {
  let name: string;
  try {
    name = UTF8_DECODER.decode(rawName);
  } catch (error) {
    failStaticAsset(
      "STATIC_ASSET_BUILD_PATH",
      "production 制品含非规范 UTF-8 路径。",
      {cause: error, sourcePath: parentPath},
    );
  }
  const isOperationalWellKnownRoot = parentPath === "build" && name === ".well-known";
  if (
    name === ""
    || name === "."
    || name === ".."
    || (name.startsWith(".") && !isOperationalWellKnownRoot)
    || name.includes("/")
    || name.includes("\\")
    || /[\u0000-\u001f\u007f-\u009f]/u.test(name)
    || !Buffer.from(name, "utf8").equals(rawName)
  ) {
    failStaticAsset(
      "STATIC_ASSET_BUILD_PATH",
      "production 制品含隐藏、控制或非规范路径段。",
      {sourcePath: parentPath},
    );
  }
  return name;
}

function scanArtifactFile(
  absolutePath: string,
  realRoot: string,
  relativePath: string,
  pathTokenAutomaton: TokenAutomaton,
  contentTokenAutomaton: TokenAutomaton,
  ssrPublicUrls: readonly string[],
  ssrImageReferenceIndexes: Set<number>,
): ScannedArtifact {
  const sourcePath = `build/${relativePath}`;
  let descriptor: number | undefined;
  let operationError: unknown;
  let evidence: BuildFileEvidence | undefined;
  let hasLeakedPathToken = false;
  let hasLeakedContentToken = false;
  try {
    const before = lstatSync(absolutePath, {bigint: true});
    if (before.isSymbolicLink() || !before.isFile()) {
      failStaticAsset(
        "STATIC_ASSET_BUILD_FILE_TYPE",
        "production 制品成员必须是普通文件且不能是符号链接。",
        {sourcePath},
      );
    }
    if (before.nlink !== 1n) {
      failStaticAsset(
        "STATIC_ASSET_BUILD_HARDLINK",
        "production 制品普通文件不能有额外硬链接。",
        {sourcePath},
      );
    }
    assertCurrentOwner(before, sourcePath);
    if (before.size > BigInt(MAX_BUILD_FILE_BYTES)) {
      failStaticAsset(
        "STATIC_ASSET_BUILD_SIZE",
        "production 制品单文件超过泄漏检查上限。",
        {sourcePath},
      );
    }
    const realBefore = realpathSync(absolutePath);
    if (!isPathWithin(realRoot, realBefore)) {
      failStaticAsset(
        "STATIC_ASSET_BUILD_ESCAPE",
        "production 制品真实路径逃逸构建根。",
        {sourcePath},
      );
    }
    descriptor = openSync(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(descriptor, {bigint: true});
    if (!opened.isFile() || opened.nlink !== 1n || !sameFileIdentity(before, opened)) {
      failStaticAsset(
        "STATIC_ASSET_BUILD_IDENTITY",
        "production 制品成员在打开前后发生身份漂移。",
        {sourcePath},
      );
    }

    const digest = createHash("sha256");
    const buffer = new Uint8Array(READ_CHUNK_BYTES);
    const isHtml = relativePath.endsWith(".html");
    if (isHtml && opened.size > BigInt(MAX_HTML_BYTES)) {
      failStaticAsset(
        "STATIC_ASSET_BUILD_HTML_SIZE",
        "SSR HTML 超过属性引用检查上限。",
        {sourcePath},
      );
    }
    const length = Number(opened.size);
    const htmlBytes = isHtml ? new Uint8Array(length) : undefined;
    let pathMatcherState = 0;
    let contentMatcherState = 0;
    let offset = 0;
    while (offset < length) {
      const count = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.byteLength, length - offset),
        offset,
      );
      if (count <= 0) {
        failStaticAsset(
          "STATIC_ASSET_BUILD_READ",
          "production 制品成员读取不完整。",
          {sourcePath},
        );
      }
      const chunk = buffer.slice(0, count);
      digest.update(chunk);
      if (htmlBytes !== undefined) htmlBytes.set(chunk, offset);
      const pathTokenResult = scanTokenChunk(
        pathTokenAutomaton,
        pathMatcherState,
        chunk,
      );
      pathMatcherState = pathTokenResult.state;
      hasLeakedPathToken ||= pathTokenResult.hasMatch;
      const contentTokenResult = scanTokenChunk(
        contentTokenAutomaton,
        contentMatcherState,
        chunk,
      );
      contentMatcherState = contentTokenResult.state;
      hasLeakedContentToken ||= contentTokenResult.hasMatch;
      offset += count;
    }
    const afterRead = fstatSync(descriptor, {bigint: true});
    const afterPath = lstatSync(absolutePath, {bigint: true});
    const realAfter = realpathSync(absolutePath);
    if (
      !sameFileIdentity(opened, afterRead)
      || !sameFileIdentity(opened, afterPath)
      || realAfter !== realBefore
      || !isPathWithin(realRoot, realAfter)
    ) {
      failStaticAsset(
        "STATIC_ASSET_BUILD_IDENTITY",
        "production 制品成员在读取期间发生身份或路径漂移。",
        {sourcePath},
      );
    }
    if (htmlBytes !== undefined) {
      let html: string;
      try {
        html = UTF8_DECODER.decode(htmlBytes);
      } catch (error) {
        failStaticAsset(
          "STATIC_ASSET_BUILD_HTML_UTF8",
          "SSR HTML 不是规范 UTF-8。",
          {cause: error, sourcePath},
        );
      }
      for (const referenceIndex of findSsrImageReferenceIndexes(
        html,
        ssrPublicUrls,
      )) ssrImageReferenceIndexes.add(referenceIndex);
    }
    evidence = Object.freeze({
      relativePath,
      byteLength: length,
      sha256: digest.digest("hex"),
    });
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  if (closeError !== undefined) {
    failStaticAsset(
      "STATIC_ASSET_BUILD_CLOSE",
      "production 制品文件描述符关闭失败。",
      {cause: closeError, sourcePath},
    );
  }
  if (operationError !== undefined) rethrowIo(operationError, sourcePath);
  if (evidence === undefined) {
    failStaticAsset(
      "STATIC_ASSET_BUILD_READ",
      "production 制品成员未产生检查证据。",
      {sourcePath},
    );
  }
  return Object.freeze({
    evidence,
    hasLeakedPathToken,
    hasLeakedContentToken,
  });
}

function readRawBuildNames(directory: string, sourcePath: string): Buffer[] {
  try {
    const names = readdirSync(directory, {
      encoding: "buffer",
      withFileTypes: false,
    }) as Buffer[];
    names.sort(Buffer.compare);
    return names;
  } catch (error) {
    return rethrowIo(error, sourcePath);
  }
}

function scanBuildTreeOnce(
  buildDirectory: string,
  pathTokenAutomaton: TokenAutomaton,
  contentTokenAutomaton: TokenAutomaton,
  ssrPublicUrls: readonly string[],
): BuildTreeEvidence {
  const realRoot = assertDirectory(buildDirectory, "build");
  if (realRoot !== buildDirectory) {
    failStaticAsset(
      "STATIC_ASSET_BUILD_ROOT",
      "production 制品根不能通过符号或别名路径进入。",
      {sourcePath: "build"},
    );
  }

  const files: BuildFileEvidence[] = [];
  const ssrImageReferenceIndexes = new Set<number>();
  const foldedPaths = new Map<string, string>();
  let hasLeakedPathToken = false;
  let hasLeakedContentToken = false;
  let totalBytes = 0;
  let totalHtmlBytes = 0;
  const walk = (directory: string, segments: readonly string[]): void => {
    if (segments.length > MAX_BUILD_DEPTH) {
      failStaticAsset(
        "STATIC_ASSET_BUILD_DEPTH",
        "production 制品目录深度超过上限。",
        {sourcePath: segments.length === 0 ? "build" : `build/${segments.join("/")}`},
      );
    }
    const parentPath = segments.length === 0 ? "build" : `build/${segments.join("/")}`;
    for (const rawName of readRawBuildNames(directory, parentPath)) {
      const name = decodeBuildName(rawName, parentPath);
      const childSegments = [...segments, name];
      const relativePath = childSegments.join("/");
      if (Buffer.byteLength(relativePath, "utf8") > MAX_BUILD_PATH_BYTES) {
        failStaticAsset(
          "STATIC_ASSET_BUILD_PATH",
          "production 制品路径超过字节上限。",
          {sourcePath: parentPath},
        );
      }
      const folded = relativePath.toLocaleLowerCase("en-US");
      const previous = foldedPaths.get(folded);
      if (previous !== undefined && previous !== relativePath) {
        failStaticAsset(
          "STATIC_ASSET_BUILD_CASE_CONFLICT",
          "production 制品存在大小写冲突路径。",
          {sourcePath: `build/${relativePath}`},
        );
      }
      foldedPaths.set(folded, relativePath);

      const absolutePath = resolve(directory, name);
      let metadata: BigIntStats;
      try {
        metadata = lstatSync(absolutePath, {bigint: true});
      } catch (error) {
        rethrowIo(error, `build/${relativePath}`);
      }
      if (metadata.isSymbolicLink()) {
        failStaticAsset(
          "STATIC_ASSET_BUILD_FILE_TYPE",
          "production 制品不得包含符号链接。",
          {sourcePath: `build/${relativePath}`},
        );
      }
      if (metadata.isDirectory()) {
        assertCurrentOwner(metadata, `build/${relativePath}`);
        walk(absolutePath, childSegments);
        continue;
      }
      if (segments.length === 0 && name === ".well-known") {
        failStaticAsset(
          "STATIC_ASSET_BUILD_FILE_TYPE",
          "production 制品的 .well-known 根成员必须是目录。",
          {sourcePath: "build/.well-known"},
        );
      }
      if (!metadata.isFile()) {
        failStaticAsset(
          "STATIC_ASSET_BUILD_FILE_TYPE",
          "production 制品不得包含特殊文件。",
          {sourcePath: `build/${relativePath}`},
        );
      }
      if (files.length >= MAX_BUILD_FILES) {
        failStaticAsset(
          "STATIC_ASSET_BUILD_COUNT",
          "production 制品文件数量超过上限。",
          {sourcePath: "build"},
        );
      }
      totalBytes += Number(metadata.size);
      if (totalBytes > MAX_BUILD_TOTAL_BYTES) {
        failStaticAsset(
          "STATIC_ASSET_BUILD_TOTAL_SIZE",
          "production 制品总字节超过泄漏检查上限。",
          {sourcePath: "build"},
        );
      }
      if (relativePath.endsWith(".html")) {
        totalHtmlBytes += Number(metadata.size);
        if (totalHtmlBytes > MAX_BUILD_HTML_TOTAL_BYTES) {
          failStaticAsset(
            "STATIC_ASSET_BUILD_HTML_TOTAL_SIZE",
            "SSR HTML 总字节超过属性引用检查上限。",
            {sourcePath: "build"},
          );
        }
      }
      const scanned = scanArtifactFile(
        absolutePath,
        realRoot,
        relativePath,
        pathTokenAutomaton,
        contentTokenAutomaton,
        ssrPublicUrls,
        ssrImageReferenceIndexes,
      );
      files.push(scanned.evidence);
      hasLeakedPathToken ||= scanned.hasLeakedPathToken;
      hasLeakedContentToken ||= scanned.hasLeakedContentToken;
    }
  };
  walk(realRoot, []);
  files.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  return Object.freeze({
    files: Object.freeze(files),
    hasLeakedToken: hasLeakedPathToken || hasLeakedContentToken,
    hasLeakedPathToken,
    hasLeakedContentToken,
    ssrImageReferenceIndexes,
  });
}

function sameIndexSet(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function sameBuildTreeEvidence(
  left: BuildTreeEvidence,
  right: BuildTreeEvidence,
): boolean {
  return left.hasLeakedToken === right.hasLeakedToken
    && left.hasLeakedPathToken === right.hasLeakedPathToken
    && left.hasLeakedContentToken === right.hasLeakedContentToken
    && sameIndexSet(left.ssrImageReferenceIndexes, right.ssrImageReferenceIndexes)
    && left.files.length === right.files.length
    && left.files.every((file, index) => {
      const candidate = right.files[index];
      return candidate !== undefined
        && file.relativePath === candidate.relativePath
        && file.byteLength === candidate.byteLength
        && file.sha256 === candidate.sha256;
    });
}

export function scanBuildTree(
  buildDirectory: string,
  pathTokens: readonly Uint8Array[],
  ssrPublicUrls: readonly string[],
): BuildTreeEvidence;
export function scanBuildTree(
  buildDirectory: string,
  pathTokens: readonly Uint8Array[],
  contentTokens: readonly Uint8Array[],
  ssrPublicUrls: readonly string[],
): BuildTreeEvidence;
export function scanBuildTree(
  buildDirectory: string,
  pathTokens: readonly Uint8Array[],
  contentTokensOrSsrPublicUrls: readonly Uint8Array[] | readonly string[],
  explicitSsrPublicUrls?: readonly string[],
): BuildTreeEvidence {
  if (
    typeof buildDirectory !== "string"
    || !isAbsolute(buildDirectory)
    || resolve(buildDirectory) !== buildDirectory
  ) {
    failStaticAsset(
      "STATIC_ASSET_BUILD_ROOT",
      "production 制品根必须是规范绝对路径。",
      {sourcePath: "build"},
    );
  }
  const pathTokenSnapshots = snapshotTokens(pathTokens, {
    maximumCount: MAX_UNPUBLISHED_PATH_TOKENS,
    maximumTokenBytes: MAX_SOURCE_PATH_BYTES,
    maximumTotalBytes: MAX_UNPUBLISHED_PATH_TOKEN_TOTAL_BYTES,
  });
  let contentTokenSnapshots: readonly Uint8Array[] = Object.freeze([]);
  const contentTokens = explicitSsrPublicUrls === undefined
    ? []
    : contentTokensOrSsrPublicUrls as readonly Uint8Array[];
  const ssrPublicUrls = explicitSsrPublicUrls === undefined
    ? contentTokensOrSsrPublicUrls as readonly string[]
    : explicitSsrPublicUrls;
  const {
    pathTokenAutomaton,
    contentTokenAutomaton,
    ssrPublicUrlSnapshots,
  } = (() => {
    try {
      contentTokenSnapshots = snapshotTokens(contentTokens, {
        maximumCount: MAX_UNPUBLISHED_CONTENT_TOKENS,
        maximumTokenBytes: MAX_UNPUBLISHED_CONTENT_TOKEN_BYTES,
        maximumTotalBytes: MAX_UNPUBLISHED_CONTENT_TOKEN_TOTAL_BYTES,
      });
      return {
        pathTokenAutomaton: compileTokenAutomaton(pathTokenSnapshots),
        contentTokenAutomaton: compileTokenAutomaton(contentTokenSnapshots),
        ssrPublicUrlSnapshots: snapshotSsrPublicUrls(ssrPublicUrls),
      };
    } finally {
      for (const token of pathTokenSnapshots) token.fill(0);
      for (const token of contentTokenSnapshots) token.fill(0);
    }
  })();
  const first = scanBuildTreeOnce(
    buildDirectory,
    pathTokenAutomaton,
    contentTokenAutomaton,
    ssrPublicUrlSnapshots,
  );
  const second = scanBuildTreeOnce(
    buildDirectory,
    pathTokenAutomaton,
    contentTokenAutomaton,
    ssrPublicUrlSnapshots,
  );
  if (!sameBuildTreeEvidence(first, second)) {
    failStaticAsset(
      "STATIC_ASSET_BUILD_DRIFT",
      "production 制品树在两次完整扫描之间发生漂移。",
      {sourcePath: "build"},
    );
  }
  return second;
}
