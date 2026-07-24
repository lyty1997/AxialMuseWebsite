import {createHash} from "node:crypto";
import type {Hash} from "node:crypto";
import {
  lstatSync,
  realpathSync,
} from "node:fs";
import type {BigIntStats} from "node:fs";
import {isAbsolute, resolve} from "node:path";
import {
  buildArticleDateIndex,
  buildProjectNavigation,
  buildWritingNavigation,
  classifyContentPath,
  validateArticleSource,
  validateProjectCatalog,
} from "../../domain/content/index.js";
import type {
  ArticleSourceInput,
  ProjectSourceInput,
  RegistryDocumentInput,
} from "../../domain/content/index.js";
import {
  MAX_SOURCE_DEPTH,
  MAX_SOURCE_FILES,
  MAX_SOURCE_PATH_BYTES,
  MAX_SOURCE_TOTAL_BYTES,
  MAX_UNPUBLISHED_FILE_BYTES,
  assertDirectory,
  compareUtf8,
  isPathWithin,
  readAsciiDirectoryNames,
  readPrivateFileSnapshot,
} from "../static-assets/file-safety.js";
import type {UnpublishedAssetSnapshotInput} from "../static-assets/index.js";
import {
  ContentDecodeError,
  decodeFrontMatter,
  decodeJsonDocument,
} from "./content-decoders.js";
import {ContentBuildError, failContentBuild} from "./errors.js";
import type {
  ContentDirectoryIdentitySnapshot,
  ContentFileIdentitySnapshot,
  ContentSourceSnapshot,
  LoadValidatedContentInput,
  LoadedContentPrivateState,
  LoadedValidatedContent,
} from "./types.js";

const CONTENT_FILE_MAX_BYTES = 2 * 1024 * 1024;
const REGISTRY_FILE_MAX_BYTES = 1024 * 1024;
const CONTENT_SECTIONS = Object.freeze(["projects", "writing"]);
const REGISTRY_PATHS = Object.freeze({
  authors: "docs/contracts/authors.json",
  experiences: "docs/contracts/project-experiences.json",
  projects: "docs/contracts/projects.json",
  staticPublic: "docs/contracts/static-public-assets.json",
  topics: "docs/contracts/topics.json",
});
const SOURCE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ASSET_FILE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+$/u;
const MARKDOWN_FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const MARKDOWN_FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;
const UTF8_DECODER = new TextDecoder("utf-8", {fatal: true});
const UTF8_ENCODER = new TextEncoder();
const validatedContent = new WeakSet<object>();
const privateStates = new WeakMap<object, LoadedContentPrivateState>();

interface ScannedAsset {
  readonly ownerKind: "project" | "article";
  readonly ownerId: string;
  readonly sourcePath: string;
  readonly relativeAssetPath: string;
  readonly bytes: Uint8Array;
}

interface ScannedContent {
  readonly sources: readonly ContentSourceSnapshot[];
  readonly projectSources: readonly ProjectSourceInput[];
  readonly articleSources: readonly ArticleSourceInput[];
  readonly assets: readonly ScannedAsset[];
  readonly sourceFileIdentities: readonly ContentFileIdentitySnapshot[];
}

interface CapturedFileSnapshot {
  readonly identity: ContentFileIdentitySnapshot;
  readonly maximumBytes: number;
  readonly bytes: Uint8Array;
}

type CapturedDirectorySnapshot = ContentDirectoryIdentitySnapshot;

interface CapturedSourceSnapshot extends CapturedFileSnapshot {
  readonly kind: "project" | "article";
  readonly projectId?: string;
  readonly sourceName?: string;
}

interface CapturedAssetSnapshot extends CapturedFileSnapshot {
  readonly ownerKind: "project" | "article";
  readonly ownerId: string;
  readonly relativeAssetPath: string;
}

interface CapturedContentBatch {
  readonly realContentRoot: string;
  readonly directories: readonly CapturedDirectorySnapshot[];
  readonly files: readonly CapturedFileSnapshot[];
  readonly sources: readonly CapturedSourceSnapshot[];
  readonly assets: readonly CapturedAssetSnapshot[];
}

interface ContentCaptureBudget {
  fileCount: number;
  totalBytes: number;
}

type RegistryName = keyof typeof REGISTRY_PATHS;

interface CapturedLoadBatch {
  readonly realContractsRoot: string;
  readonly registries: Readonly<Record<RegistryName, CapturedFileSnapshot>>;
  readonly content: CapturedContentBatch;
}

type FrontMatterParser = NonNullable<
  Parameters<typeof decodeFrontMatter>[0]["parser"]
>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertRepositoryRoot(input: unknown): string {
  if (typeof input !== "string" || !isAbsolute(input)) {
    failContentBuild("CONTENT_LOAD_ROOT", "内容装配只接受规范绝对仓库根。", {
      sourcePath: "site-content",
    });
  }
  try {
    const metadata = lstatSync(input);
    const realRoot = realpathSync(input);
    if (
      metadata.isSymbolicLink()
      || !metadata.isDirectory()
      || realRoot !== input
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) {
      throw new TypeError("invalid repository root");
    }
    return realRoot;
  } catch (error) {
    failContentBuild("CONTENT_LOAD_ROOT", "仓库根身份或所有权不合法。", {
      cause: error,
      sourcePath: "site-content",
    });
  }
}

function readSnapshot(
  repositoryRoot: string,
  realReadRoot: string,
  sourcePath: string,
  maximumBytes: number,
): Uint8Array {
  if (
    Buffer.byteLength(sourcePath, "utf8") > MAX_SOURCE_PATH_BYTES
    || sourcePath.split("/").length > MAX_SOURCE_DEPTH + 3
  ) {
    failContentBuild("CONTENT_LOAD_PATH", "内容源路径超出固定边界。", {sourcePath});
  }
  try {
    return readPrivateFileSnapshot({
      absolutePath: resolve(repositoryRoot, sourcePath),
      realRoot: realReadRoot,
      sourcePath,
      maximumBytes,
    });
  } catch (error) {
    failContentBuild("CONTENT_LOAD_FILE", "内容源未通过安全普通文件读取。", {
      cause: error,
      sourcePath,
    });
  }
}

function identityFromMetadata(
  metadata: BigIntStats,
  sourcePath: string,
  absolutePath: string,
  realPath: string,
): ContentFileIdentitySnapshot {
  return Object.freeze({
    sourcePath,
    absolutePath,
    realPath,
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
    linkCount: metadata.nlink,
    owner: metadata.uid,
    group: metadata.gid,
    size: metadata.size,
    modifiedAtNanoseconds: metadata.mtimeNs,
    changedAtNanoseconds: metadata.ctimeNs,
  });
}

function sameIdentity(
  left: ContentFileIdentitySnapshot,
  right: ContentFileIdentitySnapshot,
): boolean {
  return left.sourcePath === right.sourcePath
    && left.absolutePath === right.absolutePath
    && left.realPath === right.realPath
    && left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.linkCount === right.linkCount
    && left.owner === right.owner
    && left.group === right.group
    && left.size === right.size
    && left.modifiedAtNanoseconds === right.modifiedAtNanoseconds
    && left.changedAtNanoseconds === right.changedAtNanoseconds;
}

function inspectPathIdentity(
  absolutePath: string,
  realRoot: string,
  sourcePath: string,
  kind: "directory" | "file",
  code: string,
  message: string,
): ContentFileIdentitySnapshot {
  try {
    const metadata = lstatSync(absolutePath, {bigint: true});
    const expectedKind = kind === "file" ? metadata.isFile() : metadata.isDirectory();
    if (
      metadata.isSymbolicLink()
      || !expectedKind
      || (kind === "file" && metadata.nlink !== 1n)
      || (
        typeof process.getuid === "function"
        && metadata.uid !== BigInt(process.getuid())
      )
    ) throw new TypeError("path identity is not admissible");
    const realPath = realpathSync(absolutePath);
    if (!isPathWithin(realRoot, realPath)) {
      throw new TypeError("path identity escaped its fixed root");
    }
    return identityFromMetadata(metadata, sourcePath, absolutePath, realPath);
  } catch (error) {
    if (error instanceof ContentBuildError) throw error;
    failContentBuild(code, message, {cause: error, sourcePath});
  }
}

function captureFileSnapshot(
  repositoryRoot: string,
  realReadRoot: string,
  sourcePath: string,
  maximumBytes: number,
): CapturedFileSnapshot {
  const absolutePath = resolve(repositoryRoot, sourcePath);
  const before = inspectPathIdentity(
    absolutePath,
    realReadRoot,
    sourcePath,
    "file",
    "CONTENT_LOAD_FILE",
    "内容源未通过安全普通文件身份检查。",
  );
  const bytes = readSnapshot(repositoryRoot, realReadRoot, sourcePath, maximumBytes);
  const after = inspectPathIdentity(
    absolutePath,
    realReadRoot,
    sourcePath,
    "file",
    "CONTENT_LOAD_FILE",
    "内容源未通过安全普通文件身份检查。",
  );
  if (!sameIdentity(before, after) || after.size !== BigInt(bytes.byteLength)) {
    bytes.fill(0);
    failContentBuild("CONTENT_LOAD_SNAPSHOT_DRIFT", "内容源在整批捕获期间发生身份漂移。", {
      sourcePath,
    });
  }
  return Object.freeze({identity: after, maximumBytes, bytes});
}

function captureDirectorySnapshot(
  absolutePath: string,
  realRoot: string,
  sourcePath: string,
): CapturedDirectorySnapshot {
  const before = inspectPathIdentity(
    absolutePath,
    realRoot,
    sourcePath,
    "directory",
    "CONTENT_LOAD_DIRECTORY",
    "内容目录身份不合法。",
  );
  let names: readonly string[];
  try {
    names = readAsciiDirectoryNames(absolutePath, sourcePath);
  } catch (error) {
    failContentBuild("CONTENT_LOAD_DIRECTORY", "内容目录成员无法确定性枚举。", {
      cause: error,
      sourcePath,
    });
  }
  const after = inspectPathIdentity(
    absolutePath,
    realRoot,
    sourcePath,
    "directory",
    "CONTENT_LOAD_DIRECTORY",
    "内容目录身份不合法。",
  );
  if (!sameIdentity(before, after)) {
    failContentBuild("CONTENT_LOAD_SNAPSHOT_DRIFT", "内容目录在成员捕获期间发生身份漂移。", {
      sourcePath,
    });
  }
  return Object.freeze({identity: after, names: Object.freeze([...names])});
}

function decodeUtf8(bytes: Uint8Array, sourcePath: string): string {
  try {
    const value = UTF8_DECODER.decode(bytes);
    const canonical = UTF8_ENCODER.encode(value);
    if (
      canonical.byteLength !== bytes.byteLength
      || canonical.some((byte, index) => byte !== bytes[index])
    ) throw new TypeError("non-canonical UTF-8");
    return value;
  } catch (error) {
    failContentBuild("CONTENT_LOAD_UTF8", "Markdown/MDX 不是规范 UTF-8。", {
      cause: error,
      sourcePath,
    });
  }
}

function maskInlineCodeSpans(content: string): string {
  const masked = content.split("");
  let cursor = 0;
  while (cursor < content.length) {
    const opening = content.indexOf("`", cursor);
    if (opening < 0) break;
    let openingEnd = opening + 1;
    while (content[openingEnd] === "`") openingEnd += 1;
    if (isEscapedMarkdownMarker(content, opening)) {
      cursor = openingEnd;
      continue;
    }
    const delimiterLength = openingEnd - opening;
    const lineEnd = content.indexOf("\n", openingEnd);
    const blockEnd = lineEnd < 0 ? content.length : lineEnd;
    let candidate = openingEnd;
    let closing = -1;
    while (candidate < blockEnd) {
      candidate = content.indexOf("`", candidate);
      if (candidate < 0 || candidate >= blockEnd) break;
      let candidateEnd = candidate + 1;
      while (content[candidateEnd] === "`") candidateEnd += 1;
      if (candidateEnd - candidate === delimiterLength) {
        closing = candidate;
        break;
      }
      candidate = candidateEnd;
    }
    if (closing < 0) {
      cursor = openingEnd;
      continue;
    }
    for (let index = opening; index < closing + delimiterLength; index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
    }
    cursor = closing + delimiterLength;
  }
  return masked.join("");
}

interface MarkdownFenceContainer {
  readonly quoteDepth: number;
  readonly listIndent: number;
}

function markdownFenceOpening(line: string): Readonly<{
  candidate: string;
  container: MarkdownFenceContainer;
}> {
  let candidate = line;
  let quoteDepth = 0;
  while (true) {
    const quote = /^ {0,3}>[\t ]?/u.exec(candidate);
    if (quote === null) break;
    candidate = candidate.slice(quote[0].length);
    quoteDepth += 1;
  }
  const list = /^( {0,3})(?:[-+*]|\d+[.)])( {1,4})/u.exec(candidate);
  const listIndent = list?.[0].length ?? 0;
  if (list !== null) candidate = candidate.slice(listIndent);
  return Object.freeze({
    candidate,
    container: Object.freeze({quoteDepth, listIndent}),
  });
}

function markdownFenceContinuation(
  line: string,
  container: MarkdownFenceContainer,
): string | undefined {
  let candidate = line;
  for (let index = 0; index < container.quoteDepth; index += 1) {
    const quote = /^ {0,3}>[\t ]?/u.exec(candidate);
    if (quote === null) return undefined;
    candidate = candidate.slice(quote[0].length);
  }
  if (container.listIndent > 0) {
    const indentation = /^ */u.exec(candidate)?.[0].length ?? 0;
    if (indentation < container.listIndent) return undefined;
    candidate = candidate.slice(container.listIndent);
  }
  return candidate;
}

function maskMarkdownCode(content: string): string {
  let fence: Readonly<{
    character: "`" | "~";
    length: number;
    container: MarkdownFenceContainer;
  }> | undefined;
  const fenced = content.split(/\r?\n/u).map((line) => {
    if (fence !== undefined) {
      const continuation = markdownFenceContinuation(line, fence.container);
      if (continuation !== undefined) {
        const closingMatch = MARKDOWN_FENCE_CLOSE_PATTERN.exec(continuation);
        const marker = closingMatch?.[1] ?? "";
        const character = marker[0];
        if (
          character === fence.character
          && marker.length >= fence.length
        ) {
          fence = undefined;
        }
        return "";
      }
      fence = undefined;
    }
    const opening = markdownFenceOpening(line);
    const openingMatch = MARKDOWN_FENCE_OPEN_PATTERN.exec(opening.candidate);
    if (openingMatch !== null) {
      const marker = openingMatch[1] ?? "";
      const character = marker[0];
      const information = openingMatch[2] ?? "";
      if (
        (character === "`" || character === "~")
        && !(character === "`" && information.includes("`"))
      ) {
        fence = {
          character,
          length: marker.length,
          container: opening.container,
        };
        return "";
      }
    }
    return line;
  }).join("\n");
  return maskInlineCodeSpans(fenced);
}

function assertLocalImageDestination(destination: string, sourcePath: string): void {
  const normalized = destination.startsWith("./") ? destination.slice(2) : destination;
  if (
    !normalized.startsWith("assets/")
    || normalized === "assets/"
    || normalized.includes("?")
    || normalized.includes("#")
    || normalized.includes("%")
    || normalized.includes("\\")
    || /\s/u.test(normalized)
    || normalized.split("/").some((segment) => (
      segment === "" || segment === "." || segment === ".."
    ))
  ) {
    failContentBuild(
      "CONTENT_LOAD_DEPENDENCY",
      "正文图片只能引用同实体 assets/ 下的受控文件。",
      {sourcePath},
    );
  }
}

function isEscapedMarkdownMarker(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function markdownReferenceLabel(value: string): string {
  return value.replace(/[\t\n\f\r ]+/gu, " ").trim().toLowerCase();
}

function markdownReferenceDefinitions(content: string): ReadonlyMap<string, string> {
  const definitions = new Map<string, string>();
  const definition = /^ {0,3}\[([^\]\\\n]+)\]:[\t ]*(?:<([^<>\n]+)>|([^\s<>\n]+))(?:[\t ]+(?:\x22[^\x22\n]*\x22|\x27[^\x27\n]*\x27|\([^()\n]*\)))?[\t ]*$/u;
  for (const line of content.split("\n")) {
    const match = definition.exec(line);
    if (match === null) continue;
    const label = markdownReferenceLabel(match[1] ?? "");
    if (label !== "" && !definitions.has(label)) {
      definitions.set(label, match[2] ?? match[3] ?? "");
    }
  }
  return definitions;
}

function markdownImageDestinations(
  content: string,
  sourcePath: string,
): readonly string[] {
  const inlineImage = /^!\[([^\]\\\n]*)\]\(\s*(?:<([^<>\n]+)>|([^()\s\n]+))(?:[\t ]+(?:\x22[^\x22\n]*\x22|\x27[^\x27\n]*\x27|\([^()\n]*\)))?\s*\)/u;
  const referenceImage = /^!\[([^\]\\\n]+)\](?:\[([^\]\\\n]*)\])?/u;
  const definitions = markdownReferenceDefinitions(content);
  const destinations: string[] = [];
  for (const line of content.split("\n")) {
    let cursor = 0;
    while (cursor < line.length) {
      const opening = line.indexOf("![", cursor);
      if (opening < 0) break;
      if (isEscapedMarkdownMarker(line, opening)) {
        cursor = opening + 2;
        continue;
      }
      const inline = inlineImage.exec(line.slice(opening));
      if (inline !== null) {
        const destination = inline[2] ?? inline[3] ?? "";
        assertLocalImageDestination(destination, sourcePath);
        destinations.push(destination);
        cursor = opening + inline[0].length;
        continue;
      }
      const reference = referenceImage.exec(line.slice(opening));
      const label = reference === null
        ? ""
        : markdownReferenceLabel(
          reference[2] === undefined || reference[2] === ""
            ? reference[1] ?? ""
            : reference[2],
        );
      const destination = definitions.get(label);
      if (reference === null || destination === undefined) {
        failContentBuild(
          "CONTENT_LOAD_DEPENDENCY",
          "正文图片必须使用可闭合到同一内容快照的 Markdown 语法。",
          {sourcePath},
        );
      }
      assertLocalImageDestination(destination, sourcePath);
      destinations.push(destination);
      cursor = opening + reference[0].length;
    }
  }
  return Object.freeze(destinations);
}

function assertContentDependencyClosure(
  content: string,
  sourcePath: string,
): void {
  const active = maskMarkdownCode(content).replace(
    /\\[!\x22#$%&\x27()*+,\-./:;<=>?@[\\\]^_\x60{|}~]/gu,
    "  ",
  );
  if (
    /^\s*(?:import|export)(?:\s|\{|\*)/mu.test(active)
    || /[{}]/u.test(active)
  ) {
    failContentBuild(
      "CONTENT_LOAD_DEPENDENCY",
      "正文不得读取内容快照外模块；MDX 组件白名单尚未建立。",
      {sourcePath},
    );
  }
  if (/<\s*\/?\s*[A-Za-z][A-Za-z0-9:-]*(?:\s|\/?>)/u.test(active)) {
    failContentBuild(
      "CONTENT_LOAD_DEPENDENCY",
      "当前空白名单下正文不得使用原生 HTML 或 JSX 标签。",
      {sourcePath},
    );
  }
  markdownImageDestinations(active, sourcePath);
}

function decodeRegistry(snapshot: CapturedFileSnapshot): RegistryDocumentInput {
  const {sourcePath} = snapshot.identity;
  try {
    return deepFreeze({
      sourcePath,
      value: decodeJsonDocument({bytes: snapshot.bytes, sourcePath}),
    });
  } catch (error) {
    if (error instanceof ContentDecodeError) {
      failContentBuild("CONTENT_LOAD_DECODE", "注册表结构化解码失败。", {
        cause: error,
        sourcePath: error.sourcePath,
        upstreamCode: error.code,
      });
    }
    throw error;
  }
}

function assertNoAlternativeDocsRoots(repositoryRoot: string): void {
  const forbidden = [
    "versions.json",
    "versioned_docs",
    "versioned_sidebars",
  ];
  for (const sourcePath of forbidden) {
    try {
      lstatSync(resolve(repositoryRoot, sourcePath));
      failContentBuild(
        "CONTENT_LOAD_SECOND_ROOT",
        "单一 docs 实例禁止 versioned 内容根或清单。",
        {sourcePath},
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const i18nRoot = resolve(repositoryRoot, "i18n");
  try {
    const metadata = lstatSync(i18nRoot);
    if (
      metadata.isSymbolicLink()
      || !metadata.isDirectory()
      || !isPathWithin(repositoryRoot, realpathSync(i18nRoot))
    ) {
      failContentBuild(
        "CONTENT_LOAD_SECOND_ROOT",
        "i18n 必须是仓库内真实目录。",
        {sourcePath: "i18n"},
      );
    }
    const localeNames = readAsciiDirectoryNames(i18nRoot, "i18n");
    for (const locale of localeNames) {
      const localeRoot = resolve(i18nRoot, locale);
      for (const name of readAsciiDirectoryNames(localeRoot, `i18n/${locale}`)) {
        if (name.startsWith("docusaurus-plugin-content-docs")) {
          failContentBuild(
            "CONTENT_LOAD_SECOND_ROOT",
            "单一 docs 实例禁止 localized docs 内容根。",
            {sourcePath: `i18n/${locale}/${name}`},
          );
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof ContentBuildError) throw error;
    failContentBuild("CONTENT_LOAD_SECOND_ROOT", "localized docs 根检查失败。", {
      cause: error,
      sourcePath: "i18n",
    });
  }
}

function captureAssetDirectory(
  repositoryRoot: string,
  contentRealRoot: string,
  ownerKind: "project" | "article",
  ownerId: string,
  directories: CapturedDirectorySnapshot[],
  files: CapturedFileSnapshot[],
  assets: CapturedAssetSnapshot[],
  budget: ContentCaptureBudget,
): void {
  const walk = (segments: readonly string[]): void => {
    const relativeRoot = ["site-content", ownerKind === "project" ? "projects" : "writing", ownerId, "assets", ...segments].join("/");
    const absoluteRoot = resolve(repositoryRoot, relativeRoot);
    const directory = captureDirectorySnapshot(absoluteRoot, contentRealRoot, relativeRoot);
    directories.push(directory);
    for (const name of directory.names) {
      const sourcePath = `${relativeRoot}/${name}`;
      const absolutePath = resolve(absoluteRoot, name);
      let metadata: BigIntStats;
      try {
        metadata = lstatSync(absolutePath, {bigint: true});
      } catch (error) {
        failContentBuild("CONTENT_LOAD_ASSET", "正文素材成员无法读取。", {
          cause: error,
          sourcePath,
        });
      }
      if (metadata.isSymbolicLink()) {
        failContentBuild("CONTENT_LOAD_ASSET_LINK", "正文素材不得是符号链接。", {sourcePath});
      }
      if (metadata.isDirectory()) {
        if (!SOURCE_NAME_PATTERN.test(name) || segments.length + 1 >= MAX_SOURCE_DEPTH) {
          failContentBuild("CONTENT_LOAD_ASSET_PATH", "正文素材目录名或深度不合法。", {sourcePath});
        }
        walk([...segments, name]);
        continue;
      }
      if (!metadata.isFile() || !ASSET_FILE_PATTERN.test(name)) {
        failContentBuild("CONTENT_LOAD_ASSET_PATH", "正文素材必须是 lowercase-kebab 普通文件。", {sourcePath});
      }
      const file = captureFileSnapshot(
        repositoryRoot,
        contentRealRoot,
        sourcePath,
        MAX_UNPUBLISHED_FILE_BYTES,
      );
      registerContentFile(file, budget);
      const asset = Object.freeze({
        ...file,
        ownerKind,
        ownerId,
        relativeAssetPath: [...segments, name].join("/"),
      });
      files.push(asset);
      assets.push(asset);
    }
  };
  walk([]);
}

function registerContentFile(
  file: CapturedFileSnapshot,
  budget: ContentCaptureBudget,
): void {
  const fileCount = budget.fileCount + 1;
  const totalBytes = budget.totalBytes + file.bytes.byteLength;
  if (fileCount > MAX_SOURCE_FILES || totalBytes > MAX_SOURCE_TOTAL_BYTES) {
    file.bytes.fill(0);
    failContentBuild("CONTENT_LOAD_LIMIT", "内容文件数量或总字节超出固定边界。", {
      sourcePath: "site-content",
    });
  }
  budget.fileCount = fileCount;
  budget.totalBytes = totalBytes;
}

function captureContentBatch(
  repositoryRoot: string,
): CapturedContentBatch {
  const contentRoot = resolve(repositoryRoot, "site-content");
  const rootDirectory = captureDirectorySnapshot(
    contentRoot,
    repositoryRoot,
    "site-content",
  );
  const realContentRoot = rootDirectory.identity.realPath;
  const rootNames = rootDirectory.names;
  if (
    rootNames.length !== CONTENT_SECTIONS.length
    || rootNames.some((name, index) => name !== CONTENT_SECTIONS[index])
  ) {
    failContentBuild(
      "CONTENT_LOAD_SECTION",
      "site-content 只能包含 projects 与 writing 两个分区。",
      {sourcePath: "site-content"},
    );
  }

  const directories: CapturedDirectorySnapshot[] = [rootDirectory];
  const files: CapturedFileSnapshot[] = [];
  const sources: CapturedSourceSnapshot[] = [];
  const assets: CapturedAssetSnapshot[] = [];
  const budget: ContentCaptureBudget = {fileCount: 0, totalBytes: 0};

  try {
    for (const section of CONTENT_SECTIONS) {
      const sectionPath = `site-content/${section}`;
      const absoluteSection = resolve(repositoryRoot, sectionPath);
      const sectionDirectory = captureDirectorySnapshot(
        absoluteSection,
        realContentRoot,
        sectionPath,
      );
      directories.push(sectionDirectory);
      for (const name of sectionDirectory.names) {
        const memberPath = `${sectionPath}/${name}`;
        const absoluteMember = resolve(absoluteSection, name);
        if (name === ".gitkeep") {
          const file = captureFileSnapshot(
            repositoryRoot,
            realContentRoot,
            memberPath,
            CONTENT_FILE_MAX_BYTES,
          );
          registerContentFile(file, budget);
          files.push(file);
          continue;
        }
        if (!SOURCE_NAME_PATTERN.test(name)) {
          failContentBuild("CONTENT_LOAD_LAYOUT", "内容分区成员必须是规范实体目录。", {
            sourcePath: memberPath,
          });
        }
        const memberDirectory = captureDirectorySnapshot(
          absoluteMember,
          realContentRoot,
          memberPath,
        );
        directories.push(memberDirectory);
        const childNames = memberDirectory.names;
        if (childNames.some((child) => /^_category_\.(?:json|ya?ml)$/u.test(child))) {
          failContentBuild("CONTENT_LOAD_CATEGORY_METADATA", "禁止 category metadata 绕过唯一侧栏投影。", {
            sourcePath: memberPath,
          });
        }
        const entryNames: string[] = childNames.filter(
          (child) => child === "index.md" || child === "index.mdx",
        );
        const hasAssets = childNames.includes("assets");
        const unknown = childNames.filter((child) => !entryNames.includes(child) && child !== "assets");
        if (unknown.length > 0 || entryNames.length !== 1) {
          failContentBuild("CONTENT_LOAD_LAYOUT", "内容目录只能有唯一 index.md|index.mdx 与可选 assets/。", {
            sourcePath: memberPath,
          });
        }
        const entryName = entryNames[0];
        if (entryName === undefined) {
          failContentBuild("CONTENT_LOAD_LAYOUT", "内容目录缺少唯一正文入口。", {
            sourcePath: memberPath,
          });
        }
        const sourcePath = `${memberPath}/${entryName}`;
        const classification = classifyContentPath({
          sourcePath,
          isSymbolicLink: false,
          isRealPathWithinRoot: true,
        });
        if (!classification.ok || classification.value.kind === "other") {
          const first = classification.ok ? undefined : classification.issues[0];
          failContentBuild("CONTENT_LOAD_CLASSIFY", "正文路径未通过领域分类。", {
            sourcePath,
            upstreamCode: first?.code,
          });
        }
        const file = captureFileSnapshot(
          repositoryRoot,
          realContentRoot,
          sourcePath,
          CONTENT_FILE_MAX_BYTES,
        );
        registerContentFile(file, budget);
        let source: CapturedSourceSnapshot;
        if (classification.value.kind === "project") {
          source = Object.freeze({
            ...file,
            kind: "project",
            projectId: classification.value.projectId,
          });
        } else {
          source = Object.freeze({
            ...file,
            kind: "article",
            sourceName: classification.value.sourceName,
          });
        }
        files.push(source);
        sources.push(source);
        if (hasAssets) {
          captureAssetDirectory(
            repositoryRoot,
            realContentRoot,
            classification.value.kind,
            classification.value.kind === "project"
              ? classification.value.projectId
              : classification.value.sourceName,
            directories,
            files,
            assets,
            budget,
          );
        }
      }
    }
    directories.sort((left, right) => compareUtf8(
      left.identity.sourcePath,
      right.identity.sourcePath,
    ));
    files.sort((left, right) => compareUtf8(
      left.identity.sourcePath,
      right.identity.sourcePath,
    ));
    sources.sort((left, right) => compareUtf8(
      left.identity.sourcePath,
      right.identity.sourcePath,
    ));
    assets.sort((left, right) => compareUtf8(
      left.identity.sourcePath,
      right.identity.sourcePath,
    ));
    return Object.freeze({
      realContentRoot,
      directories: Object.freeze(directories),
      files: Object.freeze(files),
      sources: Object.freeze(sources),
      assets: Object.freeze(assets),
    });
  } catch (error) {
    for (const file of files) file.bytes.fill(0);
    throw error;
  }
}

async function decodeCapturedContent(
  captured: CapturedContentBatch,
  parser?: FrontMatterParser,
): Promise<ScannedContent> {
  const sources: ContentSourceSnapshot[] = [];
  const projectSources: ProjectSourceInput[] = [];
  const articleSources: ArticleSourceInput[] = [];
  for (const snapshot of captured.sources) {
    const {sourcePath, absolutePath} = snapshot.identity;
    const fileContent = decodeUtf8(snapshot.bytes, sourcePath);
    let decoded;
    try {
      decoded = await decodeFrontMatter({
        fileContent,
        filePath: absolutePath,
        sourcePath,
        ...(parser === undefined ? {} : {parser}),
      });
    } catch (error) {
      if (error instanceof ContentDecodeError) {
        failContentBuild("CONTENT_LOAD_DECODE", "正文 frontmatter 解码失败。", {
          cause: error,
          sourcePath: error.sourcePath,
          upstreamCode: error.code,
        });
      }
      throw error;
    }
    assertContentDependencyClosure(decoded.content, sourcePath);
    const common = {
      sourcePath,
      isSymbolicLink: false,
      isRealPathWithinRoot: true,
      frontMatter: decoded.frontMatter,
      content: decoded.content,
    };
    if (snapshot.kind === "project") {
      projectSources.push(common);
      sources.push(Object.freeze({
        kind: "project",
        sourcePath,
        absolutePath,
        fileContent,
        frontMatter: decoded.frontMatter,
        content: decoded.content,
        projectId: snapshot.projectId,
      }));
    } else {
      articleSources.push(common);
      sources.push(Object.freeze({
        kind: "article",
        sourcePath,
        absolutePath,
        fileContent,
        frontMatter: decoded.frontMatter,
        content: decoded.content,
        sourceName: snapshot.sourceName,
      }));
    }
  }
  const assets = captured.assets.map((asset) => Object.freeze({
    ownerKind: asset.ownerKind,
    ownerId: asset.ownerId,
    sourcePath: asset.identity.sourcePath,
    relativeAssetPath: asset.relativeAssetPath,
    bytes: asset.bytes,
  }));
  return Object.freeze({
    sources: Object.freeze(sources),
    projectSources: Object.freeze(projectSources),
    articleSources: Object.freeze(articleSources),
    assets: Object.freeze(assets),
    sourceFileIdentities: Object.freeze(
      captured.sources.map((source) => source.identity),
    ),
  });
}

function captureLoadBatch(repositoryRoot: string): CapturedLoadBatch {
  const contractsRoot = resolve(repositoryRoot, "docs/contracts");
  const realContractsRoot = assertDirectory(
    contractsRoot,
    "docs/contracts",
  );
  if (realContractsRoot !== contractsRoot) {
    failContentBuild(
      "CONTENT_LOAD_CONTRACT_ROOT",
      "注册表根必须是仓库内不经过符号父路径的真实目录。",
      {sourcePath: "docs/contracts"},
    );
  }
  const registries = Object.freeze({
    projects: captureFileSnapshot(
      repositoryRoot,
      realContractsRoot,
      REGISTRY_PATHS.projects,
      REGISTRY_FILE_MAX_BYTES,
    ),
    authors: captureFileSnapshot(
      repositoryRoot,
      realContractsRoot,
      REGISTRY_PATHS.authors,
      REGISTRY_FILE_MAX_BYTES,
    ),
    topics: captureFileSnapshot(
      repositoryRoot,
      realContractsRoot,
      REGISTRY_PATHS.topics,
      REGISTRY_FILE_MAX_BYTES,
    ),
    experiences: captureFileSnapshot(
      repositoryRoot,
      realContractsRoot,
      REGISTRY_PATHS.experiences,
      REGISTRY_FILE_MAX_BYTES,
    ),
    staticPublic: captureFileSnapshot(
      repositoryRoot,
      realContractsRoot,
      REGISTRY_PATHS.staticPublic,
      REGISTRY_FILE_MAX_BYTES,
    ),
  });
  try {
    return Object.freeze({
      realContractsRoot,
      registries,
      content: captureContentBatch(repositoryRoot),
    });
  } catch (error) {
    for (const registry of Object.values(registries)) registry.bytes.fill(0);
    throw error;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

function assertFileSnapshotCurrent(
  snapshot: CapturedFileSnapshot,
  repositoryRoot: string,
): void {
  const {absolutePath, sourcePath} = snapshot.identity;
  let currentBytes: Uint8Array | undefined;
  try {
    const before = inspectPathIdentity(
      absolutePath,
      repositoryRoot,
      sourcePath,
      "file",
      "CONTENT_LOAD_SNAPSHOT_DRIFT",
      "整批内容文件不再是捕获时的普通文件。",
    );
    currentBytes = readPrivateFileSnapshot({
      absolutePath,
      realRoot: repositoryRoot,
      sourcePath,
      maximumBytes: snapshot.maximumBytes,
    });
    const after = inspectPathIdentity(
      absolutePath,
      repositoryRoot,
      sourcePath,
      "file",
      "CONTENT_LOAD_SNAPSHOT_DRIFT",
      "整批内容文件不再是捕获时的普通文件。",
    );
    if (
      !sameIdentity(snapshot.identity, before)
      || !sameIdentity(before, after)
      || !sameBytes(snapshot.bytes, currentBytes)
    ) {
      failContentBuild("CONTENT_LOAD_SNAPSHOT_DRIFT", "整批内容文件的身份或字节发生漂移。", {
        sourcePath,
      });
    }
  } catch (error) {
    if (
      error instanceof ContentBuildError
      && error.code === "CONTENT_LOAD_SNAPSHOT_DRIFT"
    ) throw error;
    failContentBuild("CONTENT_LOAD_SNAPSHOT_DRIFT", "整批内容文件重验失败。", {
      cause: error,
      sourcePath,
    });
  } finally {
    currentBytes?.fill(0);
  }
}

function assertDirectorySnapshotCurrent(
  snapshot: CapturedDirectorySnapshot,
  repositoryRoot: string,
): void {
  const {absolutePath, sourcePath} = snapshot.identity;
  try {
    const before = inspectPathIdentity(
      absolutePath,
      repositoryRoot,
      sourcePath,
      "directory",
      "CONTENT_LOAD_SNAPSHOT_DRIFT",
      "整批内容目录不再是捕获时的真实目录。",
    );
    const names = readAsciiDirectoryNames(absolutePath, sourcePath);
    const after = inspectPathIdentity(
      absolutePath,
      repositoryRoot,
      sourcePath,
      "directory",
      "CONTENT_LOAD_SNAPSHOT_DRIFT",
      "整批内容目录不再是捕获时的真实目录。",
    );
    if (
      !sameIdentity(snapshot.identity, before)
      || !sameIdentity(before, after)
      || names.length !== snapshot.names.length
      || names.some((name, index) => name !== snapshot.names[index])
    ) {
      failContentBuild("CONTENT_LOAD_SNAPSHOT_DRIFT", "整批内容目录身份或成员集合发生漂移。", {
        sourcePath,
      });
    }
  } catch (error) {
    if (
      error instanceof ContentBuildError
      && error.code === "CONTENT_LOAD_SNAPSHOT_DRIFT"
    ) throw error;
    failContentBuild("CONTENT_LOAD_SNAPSHOT_DRIFT", "整批内容目录重验失败。", {
      cause: error,
      sourcePath,
    });
  }
}

function assertLoadBatchCurrent(
  batch: CapturedLoadBatch,
  repositoryRoot: string,
): void {
  for (const registry of Object.values(batch.registries)) {
    assertFileSnapshotCurrent(registry, repositoryRoot);
  }
  for (const directory of batch.content.directories) {
    assertDirectorySnapshotCurrent(directory, repositoryRoot);
  }
  for (const file of batch.content.files) {
    assertFileSnapshotCurrent(file, repositoryRoot);
  }
  assertNoAlternativeDocsRoots(repositoryRoot);
}

function clearCapturedBytes(batch: CapturedLoadBatch, includeAssets: boolean): void {
  for (const registry of Object.values(batch.registries)) registry.bytes.fill(0);
  const retainedAssets = new Set<CapturedFileSnapshot>(batch.content.assets);
  for (const file of batch.content.files) {
    if (includeAssets || !retainedAssets.has(file)) file.bytes.fill(0);
  }
}

function updateDigestBytes(hash: Hash, bytes: Uint8Array): void {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

function updateDigestString(hash: Hash, value: string): void {
  updateDigestBytes(hash, Buffer.from(value, "utf8"));
}

function contentInputDigest(batch: CapturedLoadBatch): string {
  const hash = createHash("sha256");
  updateDigestString(hash, "axial-muse-content-input-v1");
  const registries = Object.values(batch.registries).sort((left, right) => compareUtf8(
    left.identity.sourcePath,
    right.identity.sourcePath,
  ));
  updateDigestString(hash, `registries:${registries.length}`);
  for (const registry of registries) {
    updateDigestString(hash, registry.identity.sourcePath);
    updateDigestBytes(hash, registry.bytes);
  }
  updateDigestString(hash, `directories:${batch.content.directories.length}`);
  for (const directory of batch.content.directories) {
    updateDigestString(hash, directory.identity.sourcePath);
    updateDigestString(hash, `members:${directory.names.length}`);
    for (const name of directory.names) updateDigestString(hash, name);
  }
  updateDigestString(hash, `content-files:${batch.content.files.length}`);
  for (const file of batch.content.files) {
    updateDigestString(hash, file.identity.sourcePath);
    updateDigestBytes(hash, file.bytes);
  }
  return hash.digest("hex");
}

function referencesAsset(
  content: string,
  relativeAssetPath: string,
  sourcePath: string,
): boolean {
  const candidates = new Set([
    `assets/${relativeAssetPath}`,
    `./assets/${relativeAssetPath}`,
  ]);
  const active = maskMarkdownCode(content);
  if (markdownImageDestinations(active, sourcePath).some((value) => candidates.has(value))) {
    return true;
  }
  const inlineLink = /(?<!!)\[[^\]\\\n]*\]\(\s*(?:<([^<>\n]+)>|([^()\s\n]+))(?:[\t ]+(?:\x22[^\x22\n]*\x22|\x27[^\x27\n]*\x27|\([^()\n]*\)))?\s*\)/gu;
  for (const match of active.matchAll(inlineLink)) {
    if (
      match.index !== undefined
      && !isEscapedMarkdownMarker(active, match.index)
      && candidates.has(match[1] ?? match[2] ?? "")
    ) return true;
  }
  return false;
}

function buildUnpublishedAssets(
  scanned: ScannedContent,
  catalog: LoadedValidatedContent["catalog"],
  articles: LoadedValidatedContent["articles"],
): readonly UnpublishedAssetSnapshotInput[] {
  const sourceByOwner = new Map<string, ContentSourceSnapshot>();
  for (const source of scanned.sources) {
    sourceByOwner.set(`${source.kind}:${source.projectId ?? source.sourceName ?? ""}`, source);
  }
  const projectById = new Map(catalog.projects.map((project) => [project.id, project]));
  const articleBySource = new Map(articles.map((article) => [article.sourceName, article]));
  const unpublished: UnpublishedAssetSnapshotInput[] = [];
  try {
    for (const asset of scanned.assets) {
      const source = sourceByOwner.get(`${asset.ownerKind}:${asset.ownerId}`);
      if (
        source === undefined
        || !referencesAsset(source.content, asset.relativeAssetPath, source.sourcePath)
      ) {
        failContentBuild("CONTENT_LOAD_ASSET_ORPHAN", "正文素材必须被所属 Markdown/MDX 显式引用。", {
          sourcePath: asset.sourcePath,
        });
      }
      const isUnpublished = asset.ownerKind === "project"
        ? !["published", "archived"].includes(projectById.get(asset.ownerId)?.publicationStatus ?? "")
        : articleBySource.get(asset.ownerId)?.publicationStatus === "draft";
      if (isUnpublished) {
        unpublished.push(Object.freeze({
          sourcePath: asset.sourcePath,
          publicPath: null,
          bytes: asset.bytes,
        }));
      } else {
        asset.bytes.fill(0);
      }
    }
    return Object.freeze(unpublished);
  } catch (error) {
    for (const asset of scanned.assets) asset.bytes.fill(0);
    throw error;
  }
}

function assertRouteClosure(content: Pick<
  LoadedValidatedContent,
  "projectNavigation" | "writingNavigation" | "articles"
>): void {
  const routes = new Map<string, string>();
  const add = (route: string, sourcePath: string): void => {
    const canonical = route === "/" ? route : route.endsWith("/") ? route : `${route}/`;
    const existing = routes.get(canonical);
    if (existing !== undefined) {
      failContentBuild("CONTENT_ROUTE_DUPLICATE", "规范公开路由发生重复所有权。", {
        sourcePath,
        upstreamCode: existing,
      });
    }
    if (/^\/(?:assets|img|\.well-known)(?:\/|$)/u.test(canonical)) {
      failContentBuild("CONTENT_ROUTE_RESERVED", "内容路由占用框架或运维保留空间。", {
        sourcePath,
      });
    }
    routes.set(canonical, sourcePath);
  };
  for (const project of content.projectNavigation) add(project.canonicalPath, project.sourcePath);
  for (const article of content.articles) {
    if (article.publicationStatus !== "draft") add(article.slug, article.sourcePath);
  }
}

function unwrapDomainResult<T>(
  result: import("../../domain/content/index.js").ValidationResult<T>,
  code: string,
  message: string,
): T {
  if (result.ok) return result.value;
  const first = result.issues[0];
  failContentBuild(code, message, {
    sourcePath: first?.sourcePath ?? "site-content",
    upstreamCode: first?.code,
  });
}

export function assertLoadedValidatedContent(value: unknown): asserts value is LoadedValidatedContent {
  if (
    value === null
    || typeof value !== "object"
    || !validatedContent.has(value)
    || !Object.isFrozen(value)
  ) {
    failContentBuild("CONTENT_BUILD_PROVENANCE", "内容投影只接受当前 loader 的完整成功结果。", {
      sourcePath: "site-content",
    });
  }
}

export function getLoadedContentPrivateState(
  content: LoadedValidatedContent,
): LoadedContentPrivateState {
  assertLoadedValidatedContent(content);
  const state = privateStates.get(content);
  if (state === undefined) {
    failContentBuild("CONTENT_BUILD_PROVENANCE", "内容装配私有状态不可用。", {
      sourcePath: "site-content",
    });
  }
  return state;
}

function assertFileIdentityCurrent(
  identity: ContentFileIdentitySnapshot,
  repositoryRoot: string,
): void {
  const current = inspectPathIdentity(
    identity.absolutePath,
    repositoryRoot,
    identity.sourcePath,
    "file",
    "CONTENT_BUILD_SOURCE_DRIFT",
    "构建临界点的内容输入不再是已验证普通文件。",
  );
  if (!sameIdentity(identity, current)) {
    failContentBuild("CONTENT_BUILD_SOURCE_DRIFT", "构建临界点的内容输入身份发生漂移。", {
      sourcePath: identity.sourcePath,
    });
  }
}

function assertDirectoryIdentityCurrent(
  snapshot: ContentDirectoryIdentitySnapshot,
  repositoryRoot: string,
): void {
  const {identity} = snapshot;
  try {
    const before = inspectPathIdentity(
      identity.absolutePath,
      repositoryRoot,
      identity.sourcePath,
      "directory",
      "CONTENT_BUILD_SOURCE_DRIFT",
      "构建临界点的内容目录不再是已验证真实目录。",
    );
    const names = readAsciiDirectoryNames(identity.absolutePath, identity.sourcePath);
    const after = inspectPathIdentity(
      identity.absolutePath,
      repositoryRoot,
      identity.sourcePath,
      "directory",
      "CONTENT_BUILD_SOURCE_DRIFT",
      "构建临界点的内容目录不再是已验证真实目录。",
    );
    if (
      !sameIdentity(identity, before)
      || !sameIdentity(before, after)
      || names.length !== snapshot.names.length
      || names.some((name, index) => name !== snapshot.names[index])
    ) {
      failContentBuild("CONTENT_BUILD_SOURCE_DRIFT", "构建临界点的内容目录身份或成员发生漂移。", {
        sourcePath: identity.sourcePath,
      });
    }
  } catch (error) {
    if (
      error instanceof ContentBuildError
      && error.code === "CONTENT_BUILD_SOURCE_DRIFT"
    ) throw error;
    failContentBuild("CONTENT_BUILD_SOURCE_DRIFT", "构建临界点的内容目录重验失败。", {
      cause: error,
      sourcePath: identity.sourcePath,
    });
  }
}

export function assertLoadedContentSourceCurrent(
  content: LoadedValidatedContent,
  sourcePath: string,
): void {
  assertLoadedContentFilesCurrent(content);
  const state = getLoadedContentPrivateState(content);
  const identity = state.sourceFileIdentities.find(
    (candidate) => candidate.sourcePath === sourcePath,
  );
  if (identity === undefined) {
    failContentBuild("CONTENT_BUILD_SOURCE_DRIFT", "Docusaurus 回调引用了未登记的内容源。", {
      sourcePath: "site-content",
    });
  }
}

export function assertLoadedContentFilesCurrent(
  content: LoadedValidatedContent,
): void {
  const state = getLoadedContentPrivateState(content);
  for (const identity of state.fileIdentities) {
    assertFileIdentityCurrent(identity, content.repositoryRoot);
  }
  for (const directory of state.directories) {
    assertDirectoryIdentityCurrent(directory, content.repositoryRoot);
  }
  try {
    assertNoAlternativeDocsRoots(content.repositoryRoot);
  } catch (error) {
    failContentBuild("CONTENT_BUILD_SOURCE_DRIFT", "构建临界点出现替代 docs 内容根。", {
      cause: error,
      sourcePath: "site-content",
    });
  }
}

async function loadValidatedContentInternal(
  input: LoadValidatedContentInput,
  parser?: FrontMatterParser,
): Promise<LoadedValidatedContent> {
  if (
    input === null
    || typeof input !== "object"
    || Object.keys(input).sort().join("\n") !== "mode\nrepositoryRoot"
    || (input.mode !== "production" && input.mode !== "preview")
  ) {
    failContentBuild("CONTENT_LOAD_INPUT", "内容 loader 输入字段不合法。", {
      sourcePath: "site-content",
    });
  }
  const repositoryRoot = assertRepositoryRoot(input.repositoryRoot);
  assertNoAlternativeDocsRoots(repositoryRoot);
  const batch = captureLoadBatch(repositoryRoot);
  let retainAssetBytes = false;
  try {
    const inputDigest = contentInputDigest(batch);
    const registries = {
      projects: decodeRegistry(batch.registries.projects),
      authors: decodeRegistry(batch.registries.authors),
      topics: decodeRegistry(batch.registries.topics),
      experiences: decodeRegistry(batch.registries.experiences),
    };
    const staticPublicRegistry = decodeRegistry(batch.registries.staticPublic);
    const scanned = await decodeCapturedContent(batch.content, parser);
    assertLoadBatchCurrent(batch, repositoryRoot);
    const catalog = unwrapDomainResult(
      validateProjectCatalog({...registries, projectSources: scanned.projectSources}),
      "CONTENT_LOAD_PROJECTS",
      "项目注册表与正文整批校验失败。",
    );
    const articles = unwrapDomainResult(
      validateArticleSource({catalog, sources: scanned.articleSources}),
      "CONTENT_LOAD_ARTICLES",
      "技术文章整批校验失败。",
    );
    const projectNavigation = unwrapDomainResult(
      buildProjectNavigation({catalog}),
      "CONTENT_LOAD_PROJECT_NAVIGATION",
      "项目导航投影失败。",
    );
    const writingNavigation = unwrapDomainResult(
      buildWritingNavigation({mode: input.mode, catalog, articles}),
      "CONTENT_LOAD_WRITING_NAVIGATION",
      "技术分享导航投影失败。",
    );
    const articleDateIndex = unwrapDomainResult(
      buildArticleDateIndex({articles}),
      "CONTENT_LOAD_DATE_INDEX",
      "文章日期索引投影失败。",
    );
    const unpublishedAssets = buildUnpublishedAssets(scanned, catalog, articles);
    const content: LoadedValidatedContent = Object.freeze({
      mode: input.mode,
      repositoryRoot,
      catalog,
      articles,
      projectNavigation,
      writingNavigation,
      articleDateIndex,
      staticPublicRegistry,
      sources: scanned.sources,
    });
    assertRouteClosure(content);
    validatedContent.add(content);
    privateStates.set(content, Object.freeze({
      unpublishedAssets,
      sourceFileIdentities: scanned.sourceFileIdentities,
      fileIdentities: Object.freeze([
        ...Object.values(batch.registries).map((registry) => registry.identity),
        ...batch.content.files.map((file) => file.identity),
      ].sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath))),
      directories: batch.content.directories,
      inputDigest,
    }));
    retainAssetBytes = true;
    return content;
  } catch (error) {
    clearCapturedBytes(batch, true);
    throw error;
  } finally {
    if (retainAssetBytes) clearCapturedBytes(batch, false);
  }
}

export function loadValidatedContent(
  input: LoadValidatedContentInput,
): Promise<LoadedValidatedContent> {
  return loadValidatedContentInternal(input);
}

export function loadValidatedContentWithParser(
  input: LoadValidatedContentInput,
  parser: FrontMatterParser,
): Promise<LoadedValidatedContent> {
  if (typeof parser !== "function") {
    failContentBuild("CONTENT_LOAD_PARSER", "测试解析器必须是 function。", {
      sourcePath: "site-content",
    });
  }
  return loadValidatedContentInternal(input, parser);
}
