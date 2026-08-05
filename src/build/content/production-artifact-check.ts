import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import type {BigIntStats} from "node:fs";
import {tmpdir} from "node:os";
import {isAbsolute, relative, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {
  scanBuildTree,
  sha256,
  MAX_UNPUBLISHED_CONTENT_TOKEN_BYTES,
  MAX_UNPUBLISHED_CONTENT_TOKEN_TOTAL_BYTES,
  MAX_UNPUBLISHED_CONTENT_TOKENS,
} from "../static-assets/file-safety.js";
import type {
  BuildFileEvidence,
  BuildTreeEvidence,
} from "../static-assets/file-safety.js";
import type {StaticAssetPlan} from "../static-assets/index.js";
import {failContentBuild} from "./errors.js";
import type {LoadedValidatedContent} from "./types.js";
import {
  CANONICAL_ORIGIN,
  deriveProductionRuntimeRedirects,
} from "./runtime-redirects.js";

export const ARTICLE_DATE_INDEX_RELATIVE_PATH = "axial-muse/article-date-index.json";
const MIN_UNPUBLISHED_SEMANTIC_FRAGMENT_BYTES = 16;
const UTF8_DECODER = new TextDecoder("utf-8", {fatal: true});
const PROJECT_EMPTY_STATE = "当前还没有完成公开审核的项目。项目资料通过事实、隐私和视觉证据检查后会在这里出现。";
const WRITING_EMPTY_STATE = "技术分享正在从项目记录中整理。首批内容发布后会在这里提供可核验的原始资料与实现细节。";
const PROJECT_STATUS_LABELS = Object.freeze({
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  archived: "已归档",
});
const ARTICLE_STATUS_LABELS = Object.freeze({
  archived: "已归档",
});
const STATIC_PAGE_METADATA = Object.freeze({
  "/": Object.freeze({
    title: "Axial Muse | 全栈技术 + AI 的生产力工具",
    description: "Axial Muse 以全栈技术与 AI 构建好用的工具，分享公开项目、技术取舍与工程复盘。",
    h1: "用全栈技术 + AI，让所有人用上好用的工具。",
  }),
  "/projects/": Object.freeze({
    title: "项目介绍 | Axial Muse",
    description: "浏览 Axial Muse 中已完成公开审核的个人项目，查看问题、实现、技术取舍与源码资料。",
    h1: "项目介绍",
  }),
  "/writing/": Object.freeze({
    title: "踩过的坑 | Axial Muse",
    description: "浏览 Axial Muse 的技术分享，查看来自真实项目的工程问题、实现取舍与复盘记录。",
    h1: "踩过的坑",
  }),
});
const REQUIRED_GLOBAL_LINKS = Object.freeze([
  Object.freeze({href: "/", label: "Axial Muse"}),
  Object.freeze({href: "/", label: "首页"}),
  Object.freeze({href: "/projects/", label: "项目介绍"}),
  Object.freeze({href: "/writing/", label: "踩过的坑"}),
]);
const REQUIRED_HOME_LINKS = Object.freeze([
  Object.freeze({href: "#about", label: ""}),
  Object.freeze({href: "mailto:lyzimin@outlook.com", label: "EMAIL lyzimin@outlook.com ↗"}),
  Object.freeze({href: "https://github.com/lyty1997", label: "GITHUB github.com/lyty1997 ↗"}),
]);
const REQUIRED_FOOTER_LINKS = Object.freeze([
  Object.freeze({
    href: "https://beian.miit.gov.cn/",
    label: "沪ICP备2026029086号",
  }),
]);
const UNAPPROVED_ACTION_LABEL = /^(?:(?:(?:在线|立即|开始|免费)(?:体验|试用|演示))|(?:(?:体验|试用)(?:产品|项目|服务)?)|(?:(?:查看|观看|播放)(?:演示|视频))|(?:上传(?:文件|资料)?)|(?:登录(?:账户|账号)?)|(?:(?:view|watch|play)(?:[ \t]+(?:demo|video)))|(?:(?:start|try)[ \t]+(?:demo|experience|trial))|(?:demo|experience|login|upload|video|trial|watch))$/iu;
const UNAPPROVED_CJK_ACTION_PHRASE = /(?:(?:在线|立即|马上|现在|开始|免费)(?:在线)?(?:体验|试用|演示)|(?:查看|观看|播放)(?:在线)?(?:演示|视频))/u;
const UNAPPROVED_ENGLISH_ACTION_PHRASE = /\b(?:(?:view|watch|play)[ \t-]+(?:online[ \t-]+)?(?:demo|video)|(?:start|try)[ \t-]+(?:online[ \t-]+)?(?:demo|experience|trial))\b/iu;
const UNAPPROVED_BUTTON_LABEL = /(?:登录|登入|上传|体验|试用|演示|视频|播放|观看|\b(?:demo|experience|login|play|trial|upload|video|watch)\b|log[ \t-]*in)/iu;
const MEDIA_ACTION_HREF = /\.(?:m4v|mov|mp4|ogv|webm)(?:[?#].*)?$/iu;

function hasOnlyHtmlWhitespace(value: string): boolean {
  return /^[\t\n\f\r ]*$/u.test(value);
}

interface SidebarLink {
  readonly href: string;
  readonly label: string;
}

interface ArtifactAnchor {
  readonly href: string;
  readonly label: string;
}

interface ArtifactPageExpectation {
  readonly title: string;
  readonly description: string;
  readonly socialDescription: string;
  readonly canonicalPath: string;
  readonly openGraphType: "article" | "website";
  readonly h1: string;
  readonly openGraphImage?: string;
}

interface PublicArticleProjection {
  readonly articleId: string;
  readonly sourcePath: string;
  readonly title: string;
  readonly summary: string;
  readonly canonicalPath: string;
  readonly publicationStatus: "published" | "archived";
  readonly publishedAt: string;
  readonly updatedAt: string;
  readonly authors: readonly Readonly<{id: string; displayName: string}>[];
  readonly topics: readonly Readonly<{id: string; displayName: string}>[];
  readonly seo: Readonly<{
    description: string;
    socialDescription: string;
  }>;
  readonly relatedProjects: readonly Readonly<{
    title: string;
    canonicalPath: string;
  }>[];
  readonly relatedArticles: readonly Readonly<{
    title: string;
    canonicalPath: string;
  }>[];
}

export function expectedPageRoutes(repositoryRoot: string): readonly string[] {
  const pagesRoot = resolve(repositoryRoot, "src/pages");
  const routes = new Set<string>();
  const walk = (directory: string, segments: readonly string[]): void => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        failContentBuild("CONTENT_ARTIFACT_PAGE_SOURCE", "页面源不得是符号链接。", {
          sourcePath: `src/pages/${[...segments, entry.name].join("/")}`,
        });
      }
      if (entry.isDirectory()) {
        walk(path, [...segments, entry.name]);
        continue;
      }
      if (!entry.isFile()) {
        failContentBuild("CONTENT_ARTIFACT_PAGE_SOURCE", "页面源含特殊文件。", {
          sourcePath: "src/pages",
        });
      }
      const relativePath = [...segments, entry.name].join("/");
      if (entry.name.endsWith(".module.css")) continue;
      if (!entry.name.endsWith(".tsx")) {
        failContentBuild("CONTENT_ARTIFACT_PAGE_SOURCE", "页面源含未批准文件类型。", {
          sourcePath: `src/pages/${relativePath}`,
        });
      }
      const route = relativePath === "index.tsx"
        ? "/"
        : relativePath === "projects.tsx" || relativePath === "projects/index.tsx"
          ? "/projects/"
          : relativePath === "writing.tsx" || relativePath === "writing/index.tsx"
            ? "/writing/"
            : undefined;
      if (route === undefined || routes.has(route)) {
        failContentBuild("CONTENT_ARTIFACT_PAGE_ROUTE", "src/pages 产生未批准或重复路由。", {
          sourcePath: `src/pages/${relativePath}`,
        });
      }
      routes.add(route);
    }
  };
  walk(pagesRoot, []);
  return Object.freeze([...routes].sort());
}

function expectedRoutes(content: LoadedValidatedContent): readonly string[] {
  const routes = new Set(expectedPageRoutes(content.repositoryRoot));
  for (const project of content.projectNavigation) routes.add(project.canonicalPath);
  for (const article of content.articles) {
    if (article.publicationStatus !== "draft") {
      routes.add(article.slug.endsWith("/") ? article.slug : `${article.slug}/`);
    }
  }
  return Object.freeze([...routes].sort());
}

export function routeFromHtmlPath(path: string): string | undefined {
  if (path === "404.html") return undefined;
  if (path === "index.html") return "/";
  if (path.endsWith("/index.html")) return `/${path.slice(0, -"index.html".length)}`;
  failContentBuild("CONTENT_ARTIFACT_TRAILING_SLASH", "页面制品不符合 trailingSlash: true。", {
    sourcePath: `build/${path}`,
  });
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

function assertPrivateRegularFile(metadata: BigIntStats): void {
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1n
    || (
      typeof process.getuid === "function"
      && metadata.uid !== BigInt(process.getuid())
    )
  ) {
    throw new TypeError("not a private single-link regular file");
  }
}

function readStableFileBytes(
  absolutePath: string,
  sourcePath: string,
  expectedEvidence?: BuildFileEvidence,
): Uint8Array {
  let descriptor: number | undefined;
  let value: Uint8Array | undefined;
  let operationError: unknown;
  try {
    const pathBefore = lstatSync(absolutePath, {bigint: true});
    assertPrivateRegularFile(pathBefore);
    descriptor = openSync(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const descriptorBefore = fstatSync(descriptor, {bigint: true});
    assertPrivateRegularFile(descriptorBefore);
    if (!sameFileIdentity(pathBefore, descriptorBefore)) {
      throw new TypeError("path and descriptor identity differ before read");
    }
    const bytes = readFileSync(descriptor);
    const descriptorAfter = fstatSync(descriptor, {bigint: true});
    const pathAfter = lstatSync(absolutePath, {bigint: true});
    assertPrivateRegularFile(descriptorAfter);
    assertPrivateRegularFile(pathAfter);
    if (
      !sameFileIdentity(descriptorBefore, descriptorAfter)
      || !sameFileIdentity(descriptorAfter, pathAfter)
    ) {
      throw new TypeError("file identity drifted during read");
    }
    if (
      expectedEvidence !== undefined
      && (
        bytes.byteLength !== expectedEvidence.byteLength
        || sha256(bytes) !== expectedEvidence.sha256
      )
    ) {
      throw new TypeError("file bytes differ from static scan evidence");
    }
    value = Uint8Array.from(bytes);
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
  if (operationError !== undefined || closeError !== undefined || value === undefined) {
    const cause = operationError !== undefined && closeError !== undefined
      ? new AggregateError([operationError, closeError])
      : operationError ?? closeError;
    failContentBuild("CONTENT_ARTIFACT_READ", "production 制品文本无法绑定静态扫描证据。", {
      cause,
      sourcePath,
    });
  }
  return value;
}

export function readStableTextFile(
  absolutePath: string,
  sourcePath: string,
  expectedEvidence?: BuildFileEvidence,
): string {
  const bytes = readStableFileBytes(absolutePath, sourcePath, expectedEvidence);
  try {
    return UTF8_DECODER.decode(bytes);
  } catch (error) {
    failContentBuild("CONTENT_ARTIFACT_READ", "production 制品文本不是规范 UTF-8。", {
      cause: error,
      sourcePath,
    });
  } finally {
    bytes.fill(0);
  }
}

const INERT_HTML_ELEMENTS = new Set([
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);
const FORBIDDEN_PUBLIC_ELEMENTS = new Set([
  "embed",
  "iframe",
  "object",
  "video",
]);
const FORBIDDEN_HTML_TREE_BUILDERS = new Set([
  "frame",
  "frameset",
  "math",
  "plaintext",
  "select",
  "template",
]);
const RAW_HEAD_ELEMENTS = new Set([
  "link",
  "meta",
  "noscript",
  "script",
  "style",
  "title",
]);

function strictHtmlCommentEnd(
  html: string,
  opening: number,
  sourcePath: string,
): number {
  if (html.startsWith("<!-->", opening) || html.startsWith("<!--->", opening)) {
    failContentBuild(
      "CONTENT_ARTIFACT_HTML_STRUCTURE",
      "production HTML 含非规范注释边界。",
      {sourcePath},
    );
  }
  const closing = html.indexOf("-->", opening + 4);
  if (closing < 0) {
    failContentBuild(
      "CONTENT_ARTIFACT_HTML_STRUCTURE",
      "production HTML 注释未正确闭合。",
      {sourcePath},
    );
  }
  const body = html.slice(opening + 4, closing);
  if (body.includes("--") || body.includes("<!--") || body.includes("--!>")) {
    failContentBuild(
      "CONTENT_ARTIFACT_HTML_STRUCTURE",
      "production HTML 含非规范注释状态转换。",
      {sourcePath},
    );
  }
  return closing + 3;
}

function balancedForeignElementEnd(
  html: string,
  start: number,
  name: "svg",
  sourcePath: string,
): number {
  let cursor = start;
  let depth = 1;
  while (cursor < html.length) {
    const opening = html.indexOf("<", cursor);
    if (opening < 0) break;
    if (html.startsWith("<!--", opening)) {
      cursor = strictHtmlCommentEnd(html, opening, sourcePath);
      continue;
    }
    const end = htmlTagEnd(html, opening, sourcePath);
    const tag = html.slice(opening, end + 1);
    const match = /^<[\t\n\f\r ]*(\/)?[\t\n\f\r ]*([A-Za-z][A-Za-z0-9:-]*)(?=[\t\n\f\r />])/u.exec(tag);
    const tagName = (match?.[2] ?? "").toLowerCase();
    if (
      match?.[1] !== "/"
      && ["desc", "foreignobject", "script", "title"].includes(tagName)
    ) {
      failContentBuild(
        "CONTENT_ARTIFACT_HTML_STRUCTURE",
        "production SVG 含未受控的 HTML integration point。",
        {sourcePath},
      );
    }
    if (tagName === name) {
      if (match?.[1] === "/") {
        depth -= 1;
        if (depth === 0) return end + 1;
      } else if (!/\/[\t\n\f\r ]*>$/u.test(tag)) {
        depth += 1;
      }
    }
    cursor = end + 1;
  }
  failContentBuild(
    "CONTENT_ARTIFACT_HTML_STRUCTURE",
    `production HTML 的 ${name} foreign content 未正确闭合。`,
    {sourcePath},
  );
}

function htmlTagEnd(html: string, start: number, sourcePath: string): number {
  let quote: "\"" | "'" | undefined;
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "<") {
      failContentBuild(
        "CONTENT_ARTIFACT_HTML_STRUCTURE",
        "production HTML 标签结构不规范。",
        {sourcePath},
      );
    }
    if (character === ">") return index;
  }
  failContentBuild(
    "CONTENT_ARTIFACT_HTML_STRUCTURE",
    "production HTML 标签未正确闭合。",
    {sourcePath},
  );
}

function sanitizeHtmlTag(tag: string): string {
  let quote: "\"" | "'" | undefined;
  let sanitized = "";
  for (const character of tag) {
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
        sanitized += character;
      } else if (character === "<") {
        sanitized += "&#60;";
      } else if (character === ">") {
        sanitized += "&#62;";
      } else {
        sanitized += character;
      }
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    sanitized += character;
  }
  return sanitized;
}

function failUnapprovedSearchSurface(sourcePath: string): never {
  failContentBuild(
    "CONTENT_ARTIFACT_INTERACTIVE",
    "production 页面只允许无提交端点、无持久化字段的固定本地搜索表面。",
    {sourcePath},
  );
}

function assertApprovedSearchFormTag(tag: string, sourcePath: string): void {
  const attributes = htmlAttributes(tag, sourcePath);
  const allowed = new Set(["class", "role"]);
  if (
    [...attributes.keys()].some((name) => !allowed.has(name))
    || decodePageHtmlText(attributes.get("role") ?? "", sourcePath) !== "search"
  ) {
    failUnapprovedSearchSurface(sourcePath);
  }
}

function assertApprovedSearchInputTag(tag: string, sourcePath: string): void {
  const attributes = htmlAttributes(tag, sourcePath);
  if (
    decodePageHtmlText(attributes.get("type") ?? "", sourcePath) !== "search"
    || decodePageHtmlText(attributes.get("aria-label") ?? "", sourcePath)
      !== "搜索公开项目和文章"
    || decodePageHtmlText(attributes.get("autocomplete") ?? "", sourcePath) !== "off"
    || decodePageHtmlText(attributes.get("aria-autocomplete") ?? "", sourcePath)
      !== "list"
    || decodePageHtmlText(attributes.get("aria-controls") ?? "", sourcePath)
      !== "site-search-results"
    || decodePageHtmlText(attributes.get("aria-expanded") ?? "", sourcePath)
      !== "false"
    || attributes.has("name")
    || attributes.has("form")
    || attributes.has("formaction")
  ) {
    failUnapprovedSearchSurface(sourcePath);
  }
}

function assertApprovedSearchButtonTag(tag: string, sourcePath: string): void {
  const attributes = htmlAttributes(tag, sourcePath);
  if (
    decodePageHtmlText(attributes.get("type") ?? "", sourcePath) !== "submit"
    || decodePageHtmlText(attributes.get("aria-label") ?? "", sourcePath)
      !== "打开搜索结果"
    || !attributes.has("disabled")
    || attributes.has("name")
    || attributes.has("form")
    || attributes.has("formaction")
  ) {
    failUnapprovedSearchSurface(sourcePath);
  }
}

export function activeHtmlMarkup(html: string, sourcePath: string): string {
  let cursor = 0;
  let sanitized = "";
  let doctypeSeen = false;
  let inRawHead = false;
  let inApprovedSearchForm = false;
  let approvedSearchFormCount = 0;
  let approvedSearchInputCount = 0;
  let approvedSearchButtonCount = 0;
  while (cursor < html.length) {
    const opening = html.indexOf("<", cursor);
    if (opening < 0) {
      const tail = html.slice(cursor);
      if (inRawHead && !hasOnlyHtmlWhitespace(tail)) {
        failContentBuild(
          "CONTENT_ARTIFACT_HTML_STRUCTURE",
          "production HTML 的 raw head 含活动文本。",
          {sourcePath},
        );
      }
      sanitized += tail;
      break;
    }
    const text = html.slice(cursor, opening);
    if (inRawHead && !hasOnlyHtmlWhitespace(text)) {
      failContentBuild(
        "CONTENT_ARTIFACT_HTML_STRUCTURE",
        "production HTML 的 raw head 含会触发 tree-builder 重排的文本。",
        {sourcePath},
      );
    }
    sanitized += text;
    if (html.startsWith("<!--", opening)) {
      cursor = strictHtmlCommentEnd(html, opening, sourcePath);
      continue;
    }
    const end = htmlTagEnd(html, opening, sourcePath);
    const tag = html.slice(opening, end + 1);
    if (/^<!doctype[\t\n\f\r ]+html[\t\n\f\r ]*>$/iu.test(tag)) {
      if (doctypeSeen || !hasOnlyHtmlWhitespace(sanitized)) {
        failContentBuild(
          "CONTENT_ARTIFACT_HTML_STRUCTURE",
          "production HTML 的 HTML5 doctype 必须唯一且位于文档首部。",
          {sourcePath},
        );
      }
      doctypeSeen = true;
      cursor = end + 1;
      continue;
    }
    if (tag.startsWith("<!") || tag.startsWith("<?")) {
      failContentBuild(
        "CONTENT_ARTIFACT_HTML_STRUCTURE",
        "production HTML 含未受控 markup declaration。",
        {sourcePath},
      );
    }
    const match = /^<[\t\n\f\r ]*(\/?)[\t\n\f\r ]*([A-Za-z][A-Za-z0-9:-]*)(?=[\t\n\f\r />])/u.exec(tag);
    if (match === null) {
      failContentBuild(
        "CONTENT_ARTIFACT_HTML_STRUCTURE",
        "production HTML 含无法确定语义的标签边界。",
        {sourcePath},
      );
    }
    const closing = match[1] === "/";
    const name = (match[2] ?? "").toLowerCase();
    if (name === "form") {
      if (closing) {
        if (
          !inApprovedSearchForm
          || approvedSearchInputCount !== 1
          || approvedSearchButtonCount !== 1
        ) {
          failUnapprovedSearchSurface(sourcePath);
        }
        inApprovedSearchForm = false;
      } else {
        if (inApprovedSearchForm || approvedSearchFormCount !== 0) {
          failUnapprovedSearchSurface(sourcePath);
        }
        assertApprovedSearchFormTag(tag, sourcePath);
        inApprovedSearchForm = true;
        approvedSearchFormCount += 1;
        approvedSearchInputCount = 0;
        approvedSearchButtonCount = 0;
      }
    } else if (!closing && name === "input") {
      if (!inApprovedSearchForm || approvedSearchInputCount !== 0) {
        failUnapprovedSearchSurface(sourcePath);
      }
      assertApprovedSearchInputTag(tag, sourcePath);
      approvedSearchInputCount += 1;
    } else if (!closing && name === "button" && inApprovedSearchForm) {
      if (approvedSearchButtonCount !== 0) {
        failUnapprovedSearchSurface(sourcePath);
      }
      assertApprovedSearchButtonTag(tag, sourcePath);
      approvedSearchButtonCount += 1;
    } else if (
      !closing
      && inApprovedSearchForm
      && !["div", "span", "svg"].includes(name)
    ) {
      failUnapprovedSearchSurface(sourcePath);
    }
    if (!closing && FORBIDDEN_PUBLIC_ELEMENTS.has(name)) {
      failContentBuild(
        "CONTENT_ARTIFACT_INTERACTIVE",
        `production 页面不得包含 ${name} 交互表面。`,
        {sourcePath},
      );
    }
    if (!closing && name === "head") {
      inRawHead = true;
    } else if (closing && name === "head") {
      inRawHead = false;
    } else if (
      inRawHead
      && (
        closing
        || !RAW_HEAD_ELEMENTS.has(name)
      )
    ) {
      failContentBuild(
        "CONTENT_ARTIFACT_HTML_STRUCTURE",
        "production HTML 的 raw head 含会触发 tree-builder 重排的元素。",
        {sourcePath},
      );
    }
    if (FORBIDDEN_HTML_TREE_BUILDERS.has(name)) {
      failContentBuild(
        "CONTENT_ARTIFACT_HTML_STRUCTURE",
        `production HTML 含未受控的 ${name} tree-builder 上下文。`,
        {sourcePath},
      );
    }
    if (!closing && name === "svg") {
      if (/\/[\t\n\f\r ]*>$/u.test(tag)) {
        cursor = end + 1;
      } else {
        cursor = balancedForeignElementEnd(html, end + 1, "svg", sourcePath);
      }
      continue;
    }
    if (!closing && INERT_HTML_ELEMENTS.has(name)) {
      if (/\/[\t\n\f\r ]*>$/u.test(tag)) {
        failContentBuild(
          "CONTENT_ARTIFACT_HTML_STRUCTURE",
          `production HTML 的 ${name} 不得伪自闭合。`,
          {sourcePath},
        );
      }
      const closingPattern = new RegExp(
        `<\\/[\\t\\n\\f\\r ]*${name}[\\t\\n\\f\\r ]*>`,
        "giu",
      );
      closingPattern.lastIndex = end + 1;
      const inertClosing = closingPattern.exec(html);
      if (inertClosing === null) {
        failContentBuild(
          "CONTENT_ARTIFACT_HTML_STRUCTURE",
          `production HTML 的 ${name} 惰性上下文未正确闭合。`,
          {sourcePath},
        );
      }
      if (
        name === "script"
        && /<!--|<script(?=[\t\n\f\r />])/iu.test(
          html.slice(end + 1, inertClosing.index),
        )
      ) {
        failContentBuild(
          "CONTENT_ARTIFACT_HTML_STRUCTURE",
          "production HTML 的 script 含未受控 tokenizer 状态转换。",
          {sourcePath},
        );
      }
      if (name === "title") {
        const titleText = html.slice(end + 1, inertClosing.index)
          .replaceAll("<", "&#60;")
          .replaceAll(">", "&#62;");
        sanitized += `<title>${titleText}</title>`;
      }
      cursor = (inertClosing.index ?? end + 1) + inertClosing[0].length;
      continue;
    }
    sanitized += sanitizeHtmlTag(tag);
    cursor = end + 1;
  }
  if (inApprovedSearchForm) failUnapprovedSearchSurface(sourcePath);
  const structure = [...sanitized.matchAll(
    /<\/?(?:html|head|body)(?=[\t\n\f\r />])[^>]*>/giu,
  )];
  const expected = ["html", "head", "/head", "body", "/body", "/html"];
  const expectedWithOptionalHtmlClose = expected.slice(0, -1);
  const actual = structure.map((match) => {
    const name = /^<[\t\n\f\r ]*(\/)?[\t\n\f\r ]*([A-Za-z]+)/u.exec(match[0]);
    return `${name?.[1] ?? ""}${(name?.[2] ?? "").toLowerCase()}`;
  });
  if (
    !(
      (actual.length === expected.length
        && actual.every((name, index) => name === expected[index]))
      || (actual.length === expectedWithOptionalHtmlClose.length
        && actual.every((name, index) => name === expectedWithOptionalHtmlClose[index]))
    )
    || !doctypeSeen
  ) {
    failContentBuild(
      "CONTENT_ARTIFACT_HTML_STRUCTURE",
      "production HTML 必须包含唯一且有序的 html/head/body 文档结构。",
      {sourcePath},
    );
  }
  const htmlOpening = structure[0];
  const headOpening = structure[1];
  const headClosing = structure[2];
  const bodyOpening = structure[3];
  const documentClosing = structure[5] ?? structure[4];
  if (
    htmlOpening?.index === undefined
    || headOpening?.index === undefined
    || headClosing?.index === undefined
    || bodyOpening?.index === undefined
    || documentClosing?.index === undefined
    || !hasOnlyHtmlWhitespace(sanitized.slice(0, htmlOpening.index))
    || !hasOnlyHtmlWhitespace(sanitized.slice(
      htmlOpening.index + htmlOpening[0].length,
      headOpening.index,
    ))
    || !hasOnlyHtmlWhitespace(sanitized.slice(
      headClosing.index + headClosing[0].length,
      bodyOpening.index,
    ))
    || !hasOnlyHtmlWhitespace(sanitized.slice(
      documentClosing.index + documentClosing[0].length,
    ))
  ) {
    failContentBuild(
      "CONTENT_ARTIFACT_HTML_STRUCTURE",
      "production HTML 的 head/body 边界不属于受控文档结构。",
      {sourcePath},
    );
  }
  return sanitized;
}

export function htmlAttributes(tag: string, sourcePath: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  const opening = /^<[\t\n\f\r ]*\/?[\t\n\f\r ]*[A-Za-z][A-Za-z0-9:-]*/u.exec(tag);
  if (opening === null) {
    failContentBuild("CONTENT_ARTIFACT_HTML_STRUCTURE", "production HTML 标签无法解析。", {
      sourcePath,
    });
  }
  let cursor = opening[0].length;
  while (cursor < tag.length) {
    while (/[\t\n\f\r ]/u.test(tag[cursor] ?? "")) cursor += 1;
    if (tag.startsWith("/>", cursor)) {
      cursor += 2;
      break;
    }
    if (tag[cursor] === ">") {
      cursor += 1;
      break;
    }
    const nameMatch = /^[A-Za-z][A-Za-z0-9:-]*/u.exec(tag.slice(cursor));
    if (nameMatch === null) {
      failContentBuild("CONTENT_ARTIFACT_HTML_STRUCTURE", "production HTML 属性结构不规范。", {
        sourcePath,
      });
    }
    const name = nameMatch[0].toLowerCase();
    if (attributes.has(name)) {
      failContentBuild("CONTENT_ARTIFACT_HTML_STRUCTURE", "production HTML 含重复属性。", {
        sourcePath,
      });
    }
    cursor += nameMatch[0].length;
    while (/[\t\n\f\r ]/u.test(tag[cursor] ?? "")) cursor += 1;
    let value = "";
    if (tag[cursor] === "=") {
      cursor += 1;
      while (/[\t\n\f\r ]/u.test(tag[cursor] ?? "")) cursor += 1;
      const quote = tag[cursor];
      if (quote === "\"" || quote === "'") {
        const closing = tag.indexOf(quote, cursor + 1);
        if (closing < 0) {
          failContentBuild("CONTENT_ARTIFACT_HTML_STRUCTURE", "production HTML 属性引号未闭合。", {
            sourcePath,
          });
        }
        value = tag.slice(cursor + 1, closing);
        cursor = closing + 1;
      } else {
        const valueMatch = /^[^\t\n\f\r \x22\x27=<>\x60]+/u.exec(tag.slice(cursor));
        if (valueMatch === null) {
          failContentBuild("CONTENT_ARTIFACT_HTML_STRUCTURE", "production HTML 属性值不规范。", {
            sourcePath,
          });
        }
        value = valueMatch[0];
        cursor += value.length;
      }
    }
    attributes.set(name, value);
  }
  if (cursor !== tag.length) {
    failContentBuild("CONTENT_ARTIFACT_HTML_STRUCTURE", "production HTML 标签含尾随结构。", {
      sourcePath,
    });
  }
  return attributes;
}

function hasClass(
  attributes: ReadonlyMap<string, string>,
  value: string,
  sourcePath: string,
): boolean {
  return decodeHtmlText(attributes.get("class") ?? "", sourcePath)
    .split(/[\t\n\f\r ]+/u)
    .some((candidate) => candidate === value);
}

function extractUniqueElementByClass(
  html: string,
  tagName: "aside" | "nav" | "ul",
  className: string,
  sourcePath: string,
): string {
  const openingPattern = new RegExp(
    `<${tagName}(?=[\\t\\n\\f\\r />])[^>]*>`,
    "giu",
  );
  const openings = [...html.matchAll(openingPattern)].filter((match) => (
    hasClass(htmlAttributes(match[0], sourcePath), className, sourcePath)
  ));
  const isNavbar = className === "navbar";
  if (openings.length !== 1 || openings[0]?.index === undefined) {
    failContentBuild(
      isNavbar
        ? "CONTENT_ARTIFACT_NAVIGATION"
        : "CONTENT_ARTIFACT_SIDEBAR_STRUCTURE",
      isNavbar
        ? "公开页面必须包含唯一 Docusaurus navbar 容器。"
        : "公开详情页必须包含唯一 Docusaurus 文档侧栏容器。",
      {sourcePath},
    );
  }
  const opening = openings[0];
  const tagPattern = new RegExp(
    `<\\/?${tagName}(?=[\\t\\n\\f\\r />])[^>]*>`,
    "giu",
  );
  tagPattern.lastIndex = 0;
  let depth = 0;
  for (const match of html.slice(opening.index).matchAll(tagPattern)) {
    const absoluteIndex = opening.index + (match.index ?? 0);
    if (/^<\//u.test(match[0])) {
      depth -= 1;
      if (depth === 0) {
        return html.slice(
          opening.index + opening[0].length,
          absoluteIndex,
        );
      }
      if (depth < 0) break;
    } else {
      depth += 1;
    }
  }
  failContentBuild(
    isNavbar
      ? "CONTENT_ARTIFACT_NAVIGATION"
      : "CONTENT_ARTIFACT_SIDEBAR_STRUCTURE",
    isNavbar
      ? "Docusaurus navbar 容器未正确闭合。"
      : "Docusaurus 文档侧栏容器未正确闭合。",
    {sourcePath},
  );
}

function decodeArtifactHtmlText(
  value: string,
  sourcePath: string,
  errorCode: string,
  errorMessage: string,
): string {
  let failed = false;
  const entityPattern = /&(#(?:x[0-9a-f]+|[0-9]+)|amp|lt|gt|quot|apos|nbsp);/giu;
  const unconsumed = value.replace(entityPattern, "");
  const decoded = value.replace(
    entityPattern,
    (entity, body: string) => {
      const normalized = body.toLowerCase();
      if (normalized === "amp") return "&";
      if (normalized === "lt") return "<";
      if (normalized === "gt") return ">";
      if (normalized === "quot") return "\"";
      if (normalized === "apos") return "'";
      if (normalized === "nbsp") return "\u00a0";
      const radix = normalized.startsWith("#x") ? 16 : 10;
      const digits = normalized.slice(radix === 16 ? 2 : 1);
      const codePoint = Number.parseInt(digits, radix);
      if (
        !Number.isSafeInteger(codePoint)
        || codePoint < 0
        || codePoint > 0x10ffff
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        failed = true;
        return "";
      }
      return String.fromCodePoint(codePoint);
    },
  );
  if (failed || unconsumed.includes("&")) {
    failContentBuild(
      errorCode,
      errorMessage,
      {sourcePath},
    );
  }
  return decoded;
}

function decodeHtmlText(value: string, sourcePath: string): string {
  return decodeArtifactHtmlText(
    value,
    sourcePath,
    "CONTENT_ARTIFACT_SIDEBAR_STRUCTURE",
    "Docusaurus 文档侧栏含无法确定解码的 HTML entity。",
  );
}

function decodePageHtmlText(value: string, sourcePath: string): string {
  return decodeArtifactHtmlText(
    value,
    sourcePath,
    "CONTENT_ARTIFACT_HTML_STRUCTURE",
    "production HTML 含无法确定解码的 HTML entity。",
  );
}

function sidebarLinkLabel(innerHtml: string, sourcePath: string): string {
  const tags = [...innerHtml.matchAll(/<[^>]*>/gu)].map((match) => match[0]);
  if (tags.some((tag) => !/^<\/?span(?=[\t\n\f\r />])[^>]*>$/iu.test(tag))) {
    failContentBuild(
      "CONTENT_ARTIFACT_SIDEBAR_STRUCTURE",
      "Docusaurus 文档侧栏叶子标签结构发生漂移。",
      {sourcePath},
    );
  }
  const text = decodeHtmlText(innerHtml.replace(/<[^>]*>/gu, ""), sourcePath)
    .replace(/[\t\n\f\r ]+/gu, " ")
    .replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, "");
  if (text.length === 0) {
    failContentBuild(
      "CONTENT_ARTIFACT_SIDEBAR_STRUCTURE",
      "Docusaurus 文档侧栏叶子标签为空。",
      {sourcePath},
    );
  }
  return text;
}

export function extractSidebarLinks(html: string, sourcePath: string): readonly SidebarLink[] {
  const sidebar = extractUniqueElementByClass(
    html,
    "aside",
    "theme-doc-sidebar-container",
    sourcePath,
  );
  const menu = extractUniqueElementByClass(
    sidebar,
    "ul",
    "theme-doc-sidebar-menu",
    sourcePath,
  );
  const docItems = [...menu.matchAll(/<li(?=[\t\n\f\r />])[^>]*>/giu)].filter((match) => (
    hasClass(
      htmlAttributes(match[0], sourcePath),
      "theme-doc-sidebar-item-link",
      sourcePath,
    )
  ));
  const allListItems = [...menu.matchAll(/<li(?=[\t\n\f\r />])[^>]*>/giu)];
  const links: SidebarLink[] = [];
  const consumedAnchorIndexes = new Set<number>();
  for (const item of docItems) {
    if (item.index === undefined) continue;
    const nextItem = allListItems.find((candidate) => (
      candidate.index !== undefined && candidate.index > item.index
    ));
    const end = nextItem?.index ?? menu.length;
    const itemHtml = menu.slice(item.index + item[0].length, end);
    const anchors = [...itemHtml.matchAll(/<a(?=[\t\n\f\r />])[^>]*>/giu)].filter((match) => {
      const attributes = htmlAttributes(match[0], sourcePath);
      return hasClass(attributes, "menu__link", sourcePath)
        && !hasClass(attributes, "menu__link--sublist", sourcePath);
    });
    if (anchors.length !== 1 || anchors[0]?.index === undefined) {
      failContentBuild(
        "CONTENT_ARTIFACT_SIDEBAR_STRUCTURE",
        "每个 Docusaurus 文档侧栏叶子必须包含唯一文档链接。",
        {sourcePath},
      );
    }
    const anchor = anchors[0];
    const absoluteAnchorIndex = item.index + item[0].length + anchor.index;
    consumedAnchorIndexes.add(absoluteAnchorIndex);
    const closingIndex = itemHtml.indexOf("</a>", anchor.index + anchor[0].length);
    if (closingIndex < 0) {
      failContentBuild(
        "CONTENT_ARTIFACT_SIDEBAR_STRUCTURE",
        "Docusaurus 文档侧栏叶子链接未正确闭合。",
        {sourcePath},
      );
    }
    const attributes = htmlAttributes(anchor[0], sourcePath);
    const rawHref = attributes.get("href");
    if (rawHref === undefined) {
      failContentBuild(
        "CONTENT_ARTIFACT_SIDEBAR_STRUCTURE",
        "Docusaurus 文档侧栏叶子缺少 href。",
        {sourcePath},
      );
    }
    const href = decodeHtmlText(rawHref, sourcePath);
    const label = sidebarLinkLabel(
      itemHtml.slice(anchor.index + anchor[0].length, closingIndex),
      sourcePath,
    );
    links.push(Object.freeze({href, label}));
  }

  const leafAnchors = [...menu.matchAll(/<a(?=[\t\n\f\r />])[^>]*>/giu)].filter((match) => {
    const attributes = htmlAttributes(match[0], sourcePath);
    return hasClass(attributes, "menu__link", sourcePath)
      && !hasClass(attributes, "menu__link--sublist", sourcePath);
  });
  if (
    leafAnchors.length !== consumedAnchorIndexes.size
    || leafAnchors.some((anchor) => (
      anchor.index === undefined || !consumedAnchorIndexes.has(anchor.index)
    ))
  ) {
    failContentBuild(
      "CONTENT_ARTIFACT_SIDEBAR_STRUCTURE",
      "Docusaurus 文档侧栏含不属于文档叶子的菜单链接。",
      {sourcePath},
    );
  }
  return Object.freeze(links);
}

export function assertCanonical(html: string, route: string, sourcePath: string): void {
  const headOpenings = [...html.matchAll(/<head(?=[\t\n\f\r />])[^>]*>/giu)];
  const headClosings = [...html.matchAll(/<\/head[\t\n\f\r ]*>/giu)];
  const opening = headOpenings[0];
  const closing = headClosings[0];
  if (
    headOpenings.length !== 1
    || headClosings.length !== 1
    || opening?.index === undefined
    || closing?.index === undefined
    || closing.index <= opening.index + opening[0].length
  ) {
    failContentBuild("CONTENT_ARTIFACT_CANONICAL", "页面必须包含唯一真实 head。", {
      sourcePath,
    });
  }
  const head = html.slice(opening.index + opening[0].length, closing.index);
  const headTags = [...head.matchAll(/<[^>]*>/gu)].map((match) => match[0]);
  const titlePattern = /<title(?=[\t\n\f\r />])[^>]*>[\s\S]*?<\/title[\t\n\f\r ]*>/giu;
  if (
    headTags.some((tag) => (
      !/^<(?:link|meta)(?=[\t\n\f\r />])[^>]*>$/iu.test(tag)
      && !/^<\/?title(?=[\t\n\f\r />])[^>]*>$/iu.test(tag)
    ))
    || !hasOnlyHtmlWhitespace(
      head
        .replace(titlePattern, "")
        .replace(/<(?:link|meta)(?=[\t\n\f\r />])[^>]*>/giu, ""),
    )
  ) {
    failContentBuild(
      "CONTENT_ARTIFACT_CANONICAL",
      "页面 head 只能包含受控的直接 metadata 子元素。",
      {sourcePath},
    );
  }
  const canonicals = [...head.matchAll(/<link(?=[\t\n\f\r />])[^>]*>/giu)]
    .map((match) => htmlAttributes(match[0], sourcePath))
    .filter((attributes) => decodeHtmlText(
      attributes.get("rel") ?? "",
      sourcePath,
    ).toLowerCase().split(/[\t\n\f\r ]+/u).includes("canonical"))
    .map((attributes) => decodeHtmlText(
      attributes.get("href") ?? "",
      sourcePath,
    ));
  if (
    canonicals.length !== 1
    || canonicals[0] !== `${CANONICAL_ORIGIN}${route}`
  ) {
    failContentBuild("CONTENT_ARTIFACT_CANONICAL", "页面 canonical 缺失、重复或不规范。", {
      sourcePath,
    });
  }
}

function assertProductionIndexing(html: string, sourcePath: string): void {
  const hasNoIndex = [...html.matchAll(/<meta(?=[\t\n\f\r />])[^>]*>/giu)]
    .map((match) => htmlAttributes(match[0], sourcePath))
    .some((attributes) => (
      (() => {
        const name = decodeHtmlText(
          attributes.get("name") ?? "",
          sourcePath,
        ).toLowerCase();
        if (name !== "robots" && !/bot(?:$|-)/u.test(name)) return false;
        const directives = decodeHtmlText(
          attributes.get("content") ?? "",
          sourcePath,
        ).toLowerCase().split(/[\t\n\f\r ,]+/u);
        return directives.includes("noindex") || directives.includes("none");
      })()
    ));
  if (hasNoIndex) {
    failContentBuild("CONTENT_ARTIFACT_NOINDEX", "production 页面不得携带 noindex。", {
      sourcePath,
    });
  }
}

function extractUniqueElementInnerHtml(
  html: string,
  tagName: "body" | "footer" | "h1" | "main",
  sourcePath: string,
): string {
  const openings = [...html.matchAll(new RegExp(
    `<${tagName}(?=[\\t\\n\\f\\r />])[^>]*>`,
    "giu",
  ))];
  const closings = [...html.matchAll(new RegExp(
    `<\\/${tagName}[\\t\\n\\f\\r ]*>`,
    "giu",
  ))];
  const elements = [...html.matchAll(new RegExp(
    `<${tagName}(?=[\\t\\n\\f\\r />])[^>]*>([\\s\\S]*?)<\\/${tagName}[\\t\\n\\f\\r ]*>`,
    "giu",
  ))];
  if (
    openings.length !== 1
    || closings.length !== 1
    || elements.length !== 1
    || elements[0]?.[1] === undefined
  ) {
    failContentBuild(
      tagName === "h1"
        ? "CONTENT_ARTIFACT_H1"
        : "CONTENT_ARTIFACT_HTML_STRUCTURE",
      `production 页面必须包含唯一且闭合的 ${tagName} 元素。`,
      {sourcePath},
    );
  }
  return elements[0][1];
}

function visibleFragmentText(value: string, sourcePath: string): string {
  return decodePageHtmlText(value.replace(/<[^>]*>/gu, " "), sourcePath)
    .replace(/\u200b/gu, "")
    .replace(/[\t\n\f\r ]+/gu, " ")
    .trim();
}

function extractAnchors(html: string, sourcePath: string): readonly ArtifactAnchor[] {
  const openings = [...html.matchAll(/<a(?=[\t\n\f\r />])[^>]*>/giu)];
  const closings = [...html.matchAll(/<\/a[\t\n\f\r ]*>/giu)];
  const elements = [...html.matchAll(
    /(<a(?=[\t\n\f\r />])[^>]*>)([\s\S]*?)<\/a[\t\n\f\r ]*>/giu,
  )];
  if (
    openings.length !== closings.length
    || openings.length !== elements.length
    || elements.some((element) => /<a(?=[\t\n\f\r />])/iu.test(element[2] ?? ""))
  ) {
    failContentBuild(
      "CONTENT_ARTIFACT_HTML_STRUCTURE",
      "production 页面含无法唯一配对的链接元素。",
      {sourcePath},
    );
  }
  return Object.freeze(elements.map((element) => {
    const attributes = htmlAttributes(element[1] ?? "", sourcePath);
    const rawHref = attributes.get("href");
    if (rawHref === undefined) {
      failContentBuild(
        "CONTENT_ARTIFACT_NAVIGATION",
        "production 页面链接缺少 href。",
        {sourcePath},
      );
    }
    return Object.freeze({
      href: decodePageHtmlText(rawHref, sourcePath),
      label: visibleFragmentText(element[2] ?? "", sourcePath),
    });
  }));
}

function extractFlatArticleCards(
  html: string,
  sourcePath: string,
): readonly string[] {
  const openings = [...html.matchAll(/<article(?=[\t\n\f\r />])[^>]*>/giu)];
  const closings = [...html.matchAll(/<\/article[\t\n\f\r ]*>/giu)];
  const elements = [...html.matchAll(
    /<article(?=[\t\n\f\r />])[^>]*>([\s\S]*?)<\/article[\t\n\f\r ]*>/giu,
  )];
  if (
    openings.length !== closings.length
    || openings.length !== elements.length
    || elements.some((element) => /<article(?=[\t\n\f\r />])/iu.test(element[1] ?? ""))
  ) {
    failContentBuild(
      "CONTENT_ARTIFACT_HTML_STRUCTURE",
      "production 列表页含无法唯一配对或嵌套的 article 卡片。",
      {sourcePath},
    );
  }
  return Object.freeze(elements.map((element) => element[1] ?? ""));
}

function assertExactAnchors(
  anchors: readonly ArtifactAnchor[],
  expected: readonly ArtifactAnchor[],
  code: string,
  message: string,
  sourcePath: string,
): void {
  const firstMismatch = anchors.findIndex((anchor, index) => (
    anchor.href !== expected[index]?.href
    || anchor.label !== expected[index]?.label
  ));
  if (
    anchors.length !== expected.length
    || firstMismatch >= 0
  ) {
    failContentBuild(
      code,
      `${message}（实际 ${anchors.length} 项，预期 ${expected.length} 项，首个差异索引 ${firstMismatch}。）`,
      {sourcePath},
    );
  }
}

function assertRequiredLink(
  anchors: readonly ArtifactAnchor[],
  expected: ArtifactAnchor,
  sourcePath: string,
): void {
  if (!anchors.some((anchor) => (
    anchor.label === expected.label && anchor.href === expected.href
  ))) {
    failContentBuild(
      "CONTENT_ARTIFACT_NAVIGATION",
      `production 页面缺少固定链接“${expected.label}”。`,
      {sourcePath},
    );
  }
}

function assertHtmlLanguage(html: string, sourcePath: string): void {
  const openings = [...html.matchAll(/<html(?=[\t\n\f\r />])[^>]*>/giu)];
  const opening = openings[0];
  if (
    openings.length !== 1
    || opening === undefined
    || decodePageHtmlText(
      htmlAttributes(opening[0], sourcePath).get("lang") ?? "",
      sourcePath,
    ) !== "zh-CN"
  ) {
    failContentBuild(
      "CONTENT_ARTIFACT_LANGUAGE",
      "production 页面必须唯一声明 lang=\"zh-CN\"。",
      {sourcePath},
    );
  }
}

function headHtml(html: string, sourcePath: string): string {
  const opening = /<head(?=[\t\n\f\r />])[^>]*>/iu.exec(html);
  const closing = /<\/head[\t\n\f\r ]*>/iu.exec(html);
  if (
    opening?.index === undefined
    || closing?.index === undefined
    || closing.index <= opening.index + opening[0].length
  ) {
    failContentBuild(
      "CONTENT_ARTIFACT_METADATA",
      "production 页面缺少可验证 head。",
      {sourcePath},
    );
  }
  return html.slice(opening.index + opening[0].length, closing.index);
}

function metadataValues(
  head: string,
  attributeName: "name" | "property",
  attributeValue: string,
  sourcePath: string,
): readonly string[] {
  return Object.freeze([...head.matchAll(/<meta(?=[\t\n\f\r />])[^>]*>/giu)]
    .map((match) => htmlAttributes(match[0], sourcePath))
    .filter((attributes) => (
      decodePageHtmlText(
        attributes.get(attributeName) ?? "",
        sourcePath,
      ).toLowerCase() === attributeValue
    ))
    .map((attributes) => decodePageHtmlText(
      attributes.get("content") ?? "",
      sourcePath,
    )));
}

function assertUniqueMetadataValue(
  values: readonly string[],
  expected: string,
  fieldName: string,
  sourcePath: string,
): void {
  if (values.length !== 1 || values[0] !== expected) {
    failContentBuild(
      "CONTENT_ARTIFACT_METADATA",
      `production 页面 ${fieldName} 缺失、重复或不符合安全投影。`,
      {sourcePath},
    );
  }
}

function assertPageMetadata(
  html: string,
  expected: ArtifactPageExpectation,
  sourcePath: string,
): void {
  const head = headHtml(html, sourcePath);
  const titles = [...head.matchAll(
    /<title(?=[\t\n\f\r />])[^>]*>([\s\S]*?)<\/title[\t\n\f\r ]*>/giu,
  )].map((match) => decodePageHtmlText(match[1] ?? "", sourcePath));
  assertUniqueMetadataValue(titles, expected.title, "title", sourcePath);
  assertUniqueMetadataValue(
    metadataValues(head, "name", "description", sourcePath),
    expected.description,
    "description",
    sourcePath,
  );
  assertUniqueMetadataValue(
    metadataValues(head, "property", "og:title", sourcePath),
    expected.title,
    "og:title",
    sourcePath,
  );
  assertUniqueMetadataValue(
    metadataValues(head, "property", "og:description", sourcePath),
    expected.socialDescription,
    "og:description",
    sourcePath,
  );
  assertUniqueMetadataValue(
    metadataValues(head, "property", "og:url", sourcePath),
    `${CANONICAL_ORIGIN}${expected.canonicalPath}`,
    "og:url",
    sourcePath,
  );
  assertUniqueMetadataValue(
    metadataValues(head, "property", "og:type", sourcePath),
    expected.openGraphType,
    "og:type",
    sourcePath,
  );
  const imageProperties = [...head.matchAll(/<meta(?=[\t\n\f\r />])[^>]*>/giu)]
    .map((match) => htmlAttributes(match[0], sourcePath))
    .filter((attributes) => decodePageHtmlText(
      attributes.get("property") ?? "",
      sourcePath,
    ).toLowerCase().startsWith("og:image"));
  if (expected.openGraphImage === undefined) {
    if (imageProperties.length !== 0) {
      failContentBuild(
        "CONTENT_ARTIFACT_METADATA",
        "没有已验证分享图的页面不得输出 og:image metadata。",
        {sourcePath},
      );
    }
  } else {
    const images = imageProperties
      .filter((attributes) => decodePageHtmlText(
        attributes.get("property") ?? "",
        sourcePath,
      ).toLowerCase() === "og:image")
      .map((attributes) => decodePageHtmlText(
        attributes.get("content") ?? "",
        sourcePath,
      ));
    if (imageProperties.length !== 1 || images.length !== 1 || images[0] !== expected.openGraphImage) {
      failContentBuild(
        "CONTENT_ARTIFACT_METADATA",
        "项目详情 og:image 必须唯一来自已验证主预览。",
        {sourcePath},
      );
    }
  }
}

function publicArticleProjections(
  content: LoadedValidatedContent,
): readonly PublicArticleProjection[] {
  const articles: PublicArticleProjection[] = [];
  for (const group of content.writingNavigation) {
    if (group.kind === "draft") {
      failContentBuild(
        "CONTENT_ARTIFACT_SIDEBAR_MODEL",
        "production 导航投影不得包含草稿侧栏组。",
        {sourcePath: "site-content/writing"},
      );
    } else if (group.kind === "general") {
      articles.push(...group.articles);
    } else {
      articles.push(...group.rootArticles);
      for (const module of group.modules) articles.push(...module.articles);
    }
  }
  return Object.freeze(articles);
}

function expectedPageExpectation(
  content: LoadedValidatedContent,
  route: string,
  articles: readonly PublicArticleProjection[],
): ArtifactPageExpectation {
  const staticPage = route === "/"
    ? STATIC_PAGE_METADATA["/"]
    : route === "/projects/"
      ? STATIC_PAGE_METADATA["/projects/"]
      : route === "/writing/"
        ? STATIC_PAGE_METADATA["/writing/"]
        : undefined;
  if (staticPage !== undefined) {
    return Object.freeze({
      title: staticPage.title,
      description: staticPage.description,
      socialDescription: staticPage.description,
      canonicalPath: route,
      openGraphType: "website",
      h1: staticPage.h1,
    });
  }
  const project = content.projectNavigation.find((item) => item.canonicalPath === route);
  if (project !== undefined) {
    if (project.previewImage === undefined) {
      failContentBuild(
        "CONTENT_ARTIFACT_PROJECT_IMAGE",
        "production 项目投影缺少已验证主预览。",
        {sourcePath: `build/${artifactHtmlPathForRoute(route)}`},
      );
    }
    return Object.freeze({
      title: `${project.title} | Axial Muse`,
      description: project.summary,
      socialDescription: project.summary,
      canonicalPath: project.canonicalPath,
      openGraphType: "website",
      h1: project.title,
      openGraphImage: `${CANONICAL_ORIGIN}${project.previewImage.publicUrl}`,
    });
  }
  const article = articles.find((item) => item.canonicalPath === route);
  if (article !== undefined) {
    return Object.freeze({
      title: `${article.title} | Axial Muse`,
      description: article.seo.description,
      socialDescription: article.seo.socialDescription,
      canonicalPath: article.canonicalPath,
      openGraphType: "article",
      h1: article.title,
    });
  }
  failContentBuild(
    "CONTENT_ARTIFACT_ROUTE_SET",
    "production HTML 路由不属于公开页面投影。",
    {sourcePath: `build/${artifactHtmlPathForRoute(route)}`},
  );
}

function artifactHtmlPathForRoute(route: string): string {
  return route === "/" ? "index.html" : `${route.slice(1)}index.html`;
}

function assertVisibleValues(
  visibleText: string,
  values: readonly string[],
  sourcePath: string,
): void {
  if (values.some((value) => value.length === 0 || !visibleText.includes(value))) {
    failContentBuild(
      "CONTENT_ARTIFACT_DISPLAY_PROJECTION",
      "production 页面缺少公开安全显示字段。",
      {sourcePath},
    );
  }
}

function assertHref(
  anchors: readonly ArtifactAnchor[],
  href: string,
  sourcePath: string,
): void {
  if (!anchors.some((anchor) => anchor.href === href)) {
    failContentBuild(
      "CONTENT_ARTIFACT_DISPLAY_PROJECTION",
      "production 页面缺少安全投影动作 URL。",
      {sourcePath},
    );
  }
}

function assertRelatedLinks(
  html: string,
  label: "相关技术分享" | "相关项目" | "相关文章",
  links: readonly Readonly<{title: string; canonicalPath: string}>[],
  sourcePath: string,
): void {
  const lists = [...html.matchAll(
    /(<ul(?=[\t\n\f\r />])[^>]*>)([\s\S]*?)<\/ul[\t\n\f\r ]*>/giu,
  )].filter((match) => (
    decodePageHtmlText(
      htmlAttributes(match[1] ?? "", sourcePath).get("aria-label") ?? "",
      sourcePath,
    ) === label
  ));
  if (links.length === 0) {
    if (lists.length === 0) return;
    failContentBuild(
      "CONTENT_ARTIFACT_DISPLAY_PROJECTION",
      "production 详情页不得为空关系生成关联列表。",
      {sourcePath},
    );
  }
  const list = lists[0];
  if (lists.length !== 1 || list === undefined) {
    failContentBuild(
      "CONTENT_ARTIFACT_DISPLAY_PROJECTION",
      "production 详情页缺少唯一的显式关联内容列表。",
      {sourcePath},
    );
  }
  assertExactAnchors(
    extractAnchors(list[2] ?? "", sourcePath),
    Object.freeze(links.map((link) => Object.freeze({
      href: link.canonicalPath,
      label: link.title,
    }))),
    "CONTENT_ARTIFACT_DISPLAY_PROJECTION",
    "production 详情页关联内容的标题、顺序或规范链接发生漂移。",
    sourcePath,
  );
}

function assertProjectImage(
  main: string,
  project: LoadedValidatedContent["projectNavigation"][number],
  sourcePath: string,
): void {
  const previewImage = project.previewImage;
  if (previewImage === undefined) {
    failContentBuild(
      "CONTENT_ARTIFACT_PROJECT_IMAGE",
      "production 项目投影缺少已验证主预览。",
      {sourcePath},
    );
  }
  const images = [...main.matchAll(/<img(?=[\t\n\f\r />])[^>]*>/giu)]
    .map((match) => htmlAttributes(match[0], sourcePath))
    .filter((attributes) => (
      decodePageHtmlText(attributes.get("src") ?? "", sourcePath)
      === previewImage.publicUrl
    ));
  const image = images[0];
  if (
    images.length !== 1
    || image === undefined
    || decodePageHtmlText(image.get("alt") ?? "", sourcePath) !== previewImage.alt
    || decodePageHtmlText(image.get("width") ?? "", sourcePath) !== String(previewImage.width)
    || decodePageHtmlText(image.get("height") ?? "", sourcePath) !== String(previewImage.height)
  ) {
    failContentBuild(
      "CONTENT_ARTIFACT_PROJECT_IMAGE",
      "项目主预览必须按已验证 src/alt/width/height 在页面主内容中恰好投影一次。",
      {sourcePath},
    );
  }
}

function assertProjectProjection(
  main: string,
  project: LoadedValidatedContent["projectNavigation"][number],
  sourcePath: string,
  options: Readonly<{requireRelations: boolean; requireSelfLink: boolean}>,
): void {
  const visibleText = visibleFragmentText(main, sourcePath);
  assertVisibleValues(visibleText, [
    project.title,
    project.summary,
    PROJECT_STATUS_LABELS[project.status],
    ...(project.publicationStatus === "archived"
      ? [options.requireSelfLink ? "公开状态：已归档" : "公开状态 已归档"]
      : []),
    project.updatedAt,
    ...(options.requireRelations && project.relatedWriting.length > 0
      ? [
          "相关技术分享",
          ...project.relatedWriting.map((article) => article.title),
        ]
      : []),
  ], sourcePath);
  const anchors = extractAnchors(main, sourcePath);
  if (options.requireSelfLink) {
    assertHref(anchors, project.canonicalPath, sourcePath);
  }
  if (project.repositoryUrl !== undefined) {
    assertHref(anchors, project.repositoryUrl, sourcePath);
  }
  if (options.requireRelations) {
    assertRelatedLinks(
      main,
      "相关技术分享",
      project.relatedWriting,
      sourcePath,
    );
  }
  assertProjectImage(main, project, sourcePath);
}

function assertArticleProjection(
  main: string,
  article: PublicArticleProjection,
  sourcePath: string,
  options: Readonly<{
    requireRelations: boolean;
    requireSummary: boolean;
    requireSelfLink: boolean;
  }>,
): void {
  const visibleText = visibleFragmentText(main, sourcePath);
  assertVisibleValues(visibleText, [
    article.title,
    ...(options.requireSummary ? [article.summary] : []),
    ...(article.publicationStatus === "archived"
      ? [ARTICLE_STATUS_LABELS.archived]
      : []),
    article.publishedAt,
    article.updatedAt,
    ...article.authors.map((author) => author.displayName),
    ...article.topics.map((topic) => topic.displayName),
    ...(options.requireRelations && article.relatedProjects.length > 0
      ? ["相关项目", ...article.relatedProjects.map((project) => project.title)]
      : []),
    ...(options.requireRelations && article.relatedArticles.length > 0
      ? ["相关文章", ...article.relatedArticles.map((related) => related.title)]
      : []),
  ], sourcePath);
  const anchors = extractAnchors(main, sourcePath);
  if (options.requireSelfLink) {
    assertHref(anchors, article.canonicalPath, sourcePath);
  }
  if (options.requireRelations) {
    assertRelatedLinks(main, "相关项目", article.relatedProjects, sourcePath);
    assertRelatedLinks(main, "相关文章", article.relatedArticles, sourcePath);
  }
  if (visibleText.includes(article.articleId)) {
    failContentBuild(
      "CONTENT_ARTIFACT_DISPLAY_PROJECTION",
      "文章 UUID 身份不得成为主视觉字段。",
      {sourcePath},
    );
  }
}

function projectCardAnchors(
  project: LoadedValidatedContent["projectNavigation"][number],
): readonly ArtifactAnchor[] {
  return Object.freeze([
    Object.freeze({href: project.canonicalPath, label: project.title}),
    Object.freeze({href: project.canonicalPath, label: "查看项目"}),
    ...(project.repositoryUrl === undefined
      ? []
      : [Object.freeze({href: project.repositoryUrl, label: "查看源码"})]),
  ]);
}

function articleCardAnchors(
  article: PublicArticleProjection,
): readonly ArtifactAnchor[] {
  return Object.freeze([
    Object.freeze({href: article.canonicalPath, label: article.title}),
  ]);
}

function assertCardHeading(
  card: string,
  title: string,
  canonicalPath: string,
  sourcePath: string,
): void {
  const headings = [...card.matchAll(
    /<h([2-5])(?=[\t\n\f\r />])[^>]*>([\s\S]*?)<\/h\1[\t\n\f\r ]*>/giu,
  )];
  const heading = headings[0];
  if (
    headings.length !== 1
    || heading === undefined
    || visibleFragmentText(heading[2] ?? "", sourcePath) !== title
  ) {
    failContentBuild(
      "CONTENT_ARTIFACT_CARD_SET",
      "每张公开列表卡片必须包含唯一且匹配投影标题的 heading。",
      {sourcePath},
    );
  }
  assertExactAnchors(
    extractAnchors(heading[2] ?? "", sourcePath),
    Object.freeze([Object.freeze({href: canonicalPath, label: title})]),
    "CONTENT_ARTIFACT_CARD_SET",
    "公开列表卡片 heading 必须只链接到自身规范详情路由。",
    sourcePath,
  );
}

function assertCardProjectionSet(
  main: string,
  projects: LoadedValidatedContent["projectNavigation"],
  articles: readonly PublicArticleProjection[],
  sourcePath: string,
): void {
  const cards = extractFlatArticleCards(main, sourcePath);
  if (cards.length !== projects.length + articles.length) {
    failContentBuild(
      "CONTENT_ARTIFACT_CARD_SET",
      "production 列表卡片数量与安全展示投影不一致。",
      {sourcePath},
    );
  }
  const consumed = new Set<number>();
  const uniqueCard = (
    canonicalPath: string,
    label: string,
  ): Readonly<{card: string; index: number}> => {
    const index = consumed.size;
    const card = cards[index];
    if (
      card === undefined
      || consumed.has(index)
      || !extractAnchors(card, sourcePath).some((anchor) => (
        anchor.href === canonicalPath && anchor.label === label
      ))
    ) {
      failContentBuild(
        "CONTENT_ARTIFACT_CARD_SET",
        "production 列表卡片无法按投影顺序唯一闭合。",
        {sourcePath},
      );
    }
    consumed.add(index);
    return Object.freeze({card, index});
  };

  for (const project of projects) {
    const {card} = uniqueCard(project.canonicalPath, project.title);
    assertCardHeading(card, project.title, project.canonicalPath, sourcePath);
    assertProjectProjection(card, project, sourcePath, {
      requireRelations: false,
      requireSelfLink: true,
    });
    assertExactVisibleProjection(
      card,
      Object.freeze([
        project.title,
        `项目状态：${PROJECT_STATUS_LABELS[project.status]}`,
        ...(project.publicationStatus === "archived"
          ? ["公开状态：已归档"]
          : []),
        project.summary,
        "最近更新：",
        project.updatedAt,
        "查看项目",
        ...(project.repositoryUrl === undefined ? [] : ["·", "查看源码"]),
      ]),
      "CONTENT_ARTIFACT_CARD_SET",
      sourcePath,
      "项目卡片含不属于安全展示投影的可见内容。",
    );
    assertExactAnchors(
      extractAnchors(card, sourcePath),
      projectCardAnchors(project),
      "CONTENT_ARTIFACT_CARD_SET",
      "项目卡片链接集合或顺序不属于安全展示投影。",
      sourcePath,
    );
  }
  for (const article of articles) {
    const {card} = uniqueCard(article.canonicalPath, article.title);
    assertCardHeading(card, article.title, article.canonicalPath, sourcePath);
    assertArticleProjection(card, article, sourcePath, {
      requireRelations: false,
      requireSelfLink: true,
      requireSummary: true,
    });
    assertExactVisibleProjection(
      card,
      Object.freeze([
        article.title,
        article.summary,
        `作者：${article.authors.map((author) => author.displayName).join("、")}`,
        "发布于",
        article.publishedAt,
        "·",
        "更新于",
        article.updatedAt,
        ...(article.publicationStatus === "archived" ? ["·", "已归档"] : []),
        `主题：${article.topics.map((topic) => topic.displayName).join("、")}`,
      ]),
      "CONTENT_ARTIFACT_CARD_SET",
      sourcePath,
      "文章卡片含不属于安全展示投影的可见内容。",
    );
    assertExactAnchors(
      extractAnchors(card, sourcePath),
      articleCardAnchors(article),
      "CONTENT_ARTIFACT_CARD_SET",
      "文章卡片链接集合或顺序不属于安全展示投影。",
      sourcePath,
    );
  }
  if (consumed.size !== cards.length) {
    failContentBuild(
      "CONTENT_ARTIFACT_CARD_SET",
      "production 列表含不属于安全展示投影的额外卡片。",
      {sourcePath},
    );
  }
}

function assertStaticPageAnchors(
  main: string,
  expected: readonly ArtifactAnchor[],
  sourcePath: string,
): void {
  assertExactAnchors(
    extractAnchors(main, sourcePath),
    expected,
    "CONTENT_ARTIFACT_CARD_SET",
    "production 静态页含不属于固定 CTA 或安全卡片投影的链接。",
    sourcePath,
  );
}

function assertExactVisibleProjection(
  html: string,
  expectedParts: readonly string[],
  code: "CONTENT_ARTIFACT_CARD_SET" | "CONTENT_ARTIFACT_PUBLIC_COPY",
  sourcePath: string,
  message: string,
): void {
  if (visibleFragmentText(html, sourcePath) !== expectedParts.join(" ")) {
    failContentBuild(
      code,
      message,
      {sourcePath},
    );
  }
}

function withoutFlatArticleCards(main: string): string {
  return main.replace(
    /<article(?=[\t\n\f\r />])[^>]*>[\s\S]*?<\/article[\t\n\f\r ]*>/giu,
    " ",
  );
}

function publicWritingLabels(
  content: LoadedValidatedContent,
): readonly string[] {
  return Object.freeze(content.writingNavigation.flatMap((group) => (
    group.kind === "project"
      ? [group.label, ...group.modules.map((module) => module.label)]
      : [group.label]
  )));
}

function assertElementId(
  html: string,
  expectedId: "about" | "roadmap",
  sourcePath: string,
): void {
  const matches = [...html.matchAll(/<[A-Za-z][A-Za-z0-9:-]*(?=[\t\n\f\r />])[^>]*>/gu)]
    .map((match) => htmlAttributes(match[0], sourcePath))
    .filter((attributes) => decodePageHtmlText(
      attributes.get("id") ?? "",
      sourcePath,
    ) === expectedId);
  if (matches.length !== 1) {
    failContentBuild(
      "CONTENT_ARTIFACT_PUBLIC_COPY",
      `首页必须包含唯一 #${expectedId} 区域。`,
      {sourcePath},
    );
  }
}

function assertHomeProjection(
  main: string,
  sourcePath: string,
): void {
  const visibleText = visibleFragmentText(main, sourcePath);
  const fixedCopy = [
    "AXIAL MUSE · PROJECT LINE",
    "用全栈技术 + AI，让所有人用上好用的工具。",
    "Axial Muse 的愿景，是把专业能力转化为真正好用的工具，让生产力不再是少数人的特权。",
    "当前从公开项目与工程复盘开始，持续验证每一个产品方向，在边界明确、能力真实可用后再提供服务入口。",
    "WHY AXIAL MUSE",
    "来自轴心时代涌现的大师，代表经得起时间检验的思想与方法。",
    "让灵感落地，让技术成为改善日常生活的真实力量。",
    "把专业能力沉淀为人人可用、持续进化的工具与服务。",
    "我是一个全栈工程师，覆盖人工智能、系统架构、底层驱动、硬件设计、机械工程、制造工艺，曾在达摩院做系统开发。",
    "关注 AI 工程、前沿科技，正在进行多个个人项目开发。本站分享公开项目、技术取舍与复盘，不公开凭证或私有仓库。",
  ];
  assertVisibleValues(visibleText, fixedCopy, sourcePath);
  const fixedIndexes = fixedCopy.map((value) => visibleText.indexOf(value));
  if (fixedIndexes.some((value, index) => index > 0 && value <= (fixedIndexes[index - 1] ?? -1))) {
    failContentBuild(
      "CONTENT_ARTIFACT_PUBLIC_COPY",
      "首页固定公开表达顺序发生漂移。",
      {sourcePath},
    );
  }
  assertElementId(main, "about", sourcePath);
  assertStaticPageAnchors(
    main,
    REQUIRED_HOME_LINKS,
    sourcePath,
  );
  assertExactVisibleProjection(
    main,
    Object.freeze([
      fixedCopy[0] ?? "",
      fixedCopy[1] ?? "",
      fixedCopy[2] ?? "",
      fixedCopy[3] ?? "",
      fixedCopy[4] ?? "",
      "Axial · 轴心",
      fixedCopy[5] ?? "",
      "Muse · 穆斯",
      fixedCopy[6] ?? "",
      "Technology · 工具",
      fixedCopy[7] ?? "",
      "ABOUT",
      "关于我",
      fixedCopy[8] ?? "",
      fixedCopy[9] ?? "",
      "EMAIL",
      "lyzimin@outlook.com",
      "↗",
      "GITHUB",
      "github.com/lyty1997",
      "↗",
    ]),
    "CONTENT_ARTIFACT_PUBLIC_COPY",
    sourcePath,
    "首页含不属于固定公开表达或安全卡片投影的可见内容。",
  );
}

function assertProjectsIndexProjection(
  main: string,
  content: LoadedValidatedContent,
  sourcePath: string,
): void {
  const visibleText = visibleFragmentText(main, sourcePath);
  if (content.projectNavigation.length === 0) {
    assertVisibleValues(visibleText, [PROJECT_EMPTY_STATE], sourcePath);
  }
  assertCardProjectionSet(main, content.projectNavigation, [], sourcePath);
  assertStaticPageAnchors(
    main,
    Object.freeze(content.projectNavigation.flatMap(projectCardAnchors)),
    sourcePath,
  );
  assertExactVisibleProjection(
    withoutFlatArticleCards(main),
    Object.freeze([
      "PROJECTS",
      "项目介绍",
      "从真实问题出发，记录每个项目的设计、实现与关键取舍。",
      ...(content.projectNavigation.length === 0 ? [PROJECT_EMPTY_STATE] : []),
    ]),
    "CONTENT_ARTIFACT_PUBLIC_COPY",
    sourcePath,
    "项目目录含不属于固定空状态或安全卡片投影的可见内容。",
  );
}

function assertWritingIndexProjection(
  main: string,
  content: LoadedValidatedContent,
  articles: readonly PublicArticleProjection[],
  sourcePath: string,
): void {
  const visibleText = visibleFragmentText(main, sourcePath);
  if (articles.length === 0) {
    assertVisibleValues(visibleText, [WRITING_EMPTY_STATE], sourcePath);
  } else {
    for (const group of content.writingNavigation) {
      if (group.kind === "draft") continue;
      assertVisibleValues(visibleText, [group.label], sourcePath);
      if (group.kind === "project") {
        for (const module of group.modules) {
          assertVisibleValues(visibleText, [module.label], sourcePath);
        }
      }
    }
  }
  assertCardProjectionSet(main, [], articles, sourcePath);
  assertStaticPageAnchors(
    main,
    Object.freeze(articles.flatMap(articleCardAnchors)),
    sourcePath,
  );
  assertExactVisibleProjection(
    withoutFlatArticleCards(main),
    Object.freeze([
      "LESSONS LEARNED",
      "踩过的坑",
      "不回避失败与弯路，沉淀来自真实项目的工程判断。",
      ...(articles.length === 0
        ? [WRITING_EMPTY_STATE]
        : publicWritingLabels(content)),
    ]),
    "CONTENT_ARTIFACT_PUBLIC_COPY",
    sourcePath,
    "技术分享目录含不属于固定空状态或安全卡片投影的可见内容。",
  );
}

function actionLabels(
  openingTag: string,
  innerHtml: string,
  sourcePath: string,
): readonly string[] {
  const attributes = htmlAttributes(openingTag, sourcePath);
  const labels = new Set<string>();
  const addLabel = (value: string): void => {
    const normalized = value
      .normalize("NFKC")
      .replace(/\p{Cf}/gu, "")
      .replace(/[\t\n\f\r ]+/gu, " ")
      .trim();
    if (normalized.length > 0) labels.add(normalized);
  };
  const addEncodedLabel = (value: string | undefined): void => {
    if (value !== undefined) addLabel(decodePageHtmlText(value, sourcePath));
  };

  addLabel(visibleFragmentText(innerHtml, sourcePath));
  const accessibleContents = innerHtml
    .replace(/<(?:img|input)(?=[\t\n\f\r />])[^>]*>/giu, (tag) => {
      const descendant = htmlAttributes(tag, sourcePath);
      return descendant.get("alt")
        ?? descendant.get("aria-label")
        ?? descendant.get("title")
        ?? "";
    })
    .replace(/<[^>]*>/gu, "");
  addEncodedLabel(accessibleContents);
  addEncodedLabel(attributes.get("aria-label"));
  addEncodedLabel(attributes.get("title"));
  for (const match of innerHtml.matchAll(
    /<[A-Za-z][A-Za-z0-9:-]*(?=[\t\n\f\r />])[^>]*>/gu,
  )) {
    const descendant = htmlAttributes(match[0], sourcePath);
    addEncodedLabel(descendant.get("alt"));
    addEncodedLabel(descendant.get("aria-label"));
    addEncodedLabel(descendant.get("title"));
  }
  return Object.freeze([...labels]);
}

function isUnapprovedActionLabel(label: string): boolean {
  const compactCjk = label.replace(/[\p{P}\p{Z}\s]+/gu, "");
  return UNAPPROVED_ACTION_LABEL.test(label)
    || UNAPPROVED_ACTION_LABEL.test(compactCjk)
    || UNAPPROVED_CJK_ACTION_PHRASE.test(compactCjk)
    || UNAPPROVED_ENGLISH_ACTION_PHRASE.test(label);
}

function assertNoUnapprovedServiceReferences(
  body: string,
  content: LoadedValidatedContent,
  sourcePath: string,
): void {
  const canonicalHostname = (value: string): string => {
    const lower = value.toLowerCase();
    return lower.endsWith(".") ? lower.slice(0, -1) : lower;
  };
  const experienceHostnames = new Set(
    content.catalog.experiences.map((experience) => (
      canonicalHostname(experience.hostname)
    )),
  );
  const unfinishedVideoValues = new Set<string>();
  for (const project of content.catalog.projects) {
    if (project.demoVideoStatus === "approved") continue;
    for (const value of [
      project.demoVideoUrl,
      project.demoVideoPoster,
      project.demoVideoCaptions,
    ]) {
      if (value !== undefined) unfinishedVideoValues.add(value);
    }
  }
  const tags = [...body.matchAll(/<[A-Za-z][A-Za-z0-9:-]*(?=[\t\n\f\r />])[^>]*>/gu)];
  for (const tag of tags) {
    const attributes = htmlAttributes(tag[0], sourcePath);
    for (const name of ["data", "href", "poster", "src"]) {
      const rawValue = attributes.get(name);
      if (rawValue === undefined) continue;
      const value = decodePageHtmlText(rawValue, sourcePath);
      if (unfinishedVideoValues.has(value)) {
        failContentBuild(
          "CONTENT_ARTIFACT_INTERACTIVE",
          "公开页面不得引用尚未审核完成的视频素材。",
          {sourcePath},
        );
      }
      let url: URL | undefined;
      try {
        url = new URL(value, CANONICAL_ORIGIN);
      } catch {
        // 非 URL 属性仍由既有 HTML、路由与资源闭包处理。
      }
      if (
        url !== undefined
        && (url.protocol === "http:" || url.protocol === "https:")
        && experienceHostnames.has(canonicalHostname(url.hostname))
      ) {
        failContentBuild(
          "CONTENT_ARTIFACT_INTERACTIVE",
          "M0 页面不得引用尚未批准上线的项目体验域名。",
          {sourcePath},
        );
      }
    }
  }
}

function assertNoUnapprovedPublicActions(
  body: string,
  content: LoadedValidatedContent,
  sourcePath: string,
): void {
  assertNoUnapprovedServiceReferences(body, content, sourcePath);
  const anchors = [...body.matchAll(
    /(<a(?=[\t\n\f\r />])[^>]*>)([\s\S]*?)<\/a[\t\n\f\r ]*>/giu,
  )];
  const buttons = [...body.matchAll(
    /(<button(?=[\t\n\f\r />])[^>]*>)([\s\S]*?)<\/button[\t\n\f\r ]*>/giu,
  )];
  const hasUnapprovedAnchor = anchors.some((match) => {
    const attributes = htmlAttributes(match[1] ?? "", sourcePath);
    const href = decodePageHtmlText(attributes.get("href") ?? "", sourcePath);
    return MEDIA_ACTION_HREF.test(href)
      || actionLabels(match[1] ?? "", match[2] ?? "", sourcePath)
        .some(isUnapprovedActionLabel);
  });
  const hasUnapprovedButton = buttons.some((match) => (
    actionLabels(match[1] ?? "", match[2] ?? "", sourcePath)
      .some((label) => (
        isUnapprovedActionLabel(label)
        || UNAPPROVED_BUTTON_LABEL.test(label)
      ))
  ));
  if (hasUnapprovedAnchor || hasUnapprovedButton) {
    failContentBuild(
      "CONTENT_ARTIFACT_INTERACTIVE",
      "公开页面不得暴露未上线体验、上传、登录或视频动作。",
      {sourcePath},
    );
  }
}

function assertGlobalChrome(html: string, sourcePath: string): void {
  const body = extractUniqueElementInnerHtml(html, "body", sourcePath);
  const navbar = extractUniqueElementByClass(body, "nav", "navbar", sourcePath);
  const searchForms = [...navbar.matchAll(
    /(<form(?=[\t\n\f\r />])[^>]*>)([\s\S]*?)<\/form[\t\n\f\r ]*>/giu,
  )];
  if (searchForms.length !== 1) failUnapprovedSearchSurface(sourcePath);
  assertApprovedSearchFormTag(searchForms[0]?.[1] ?? "", sourcePath);
  const searchInputTags = [
    ...(searchForms[0]?.[2] ?? "").matchAll(/<input(?=[\t\n\f\r />])[^>]*>/giu),
  ];
  const searchButtonTags = [
    ...(searchForms[0]?.[2] ?? "").matchAll(/<button(?=[\t\n\f\r />])[^>]*>/giu),
  ];
  if (searchInputTags.length !== 1 || searchButtonTags.length !== 1) {
    failUnapprovedSearchSurface(sourcePath);
  }
  assertApprovedSearchInputTag(searchInputTags[0]?.[0] ?? "", sourcePath);
  assertApprovedSearchButtonTag(searchButtonTags[0]?.[0] ?? "", sourcePath);
  const anchors = extractAnchors(navbar, sourcePath);
  assertExactAnchors(
    anchors,
    REQUIRED_GLOBAL_LINKS,
    "CONTENT_ARTIFACT_NAVIGATION",
    "production navbar 链接集合或顺序不属于固定 M0 导航。",
    sourcePath,
  );
  const footer = extractUniqueElementInnerHtml(body, "footer", sourcePath);
  const footerText = visibleFragmentText(footer, sourcePath);
  assertVisibleValues(footerText, ["2026 Axial Muse", "沪ICP备2026029086号"], sourcePath);
  const footerAnchors = extractAnchors(footer, sourcePath);
  assertExactAnchors(
    footerAnchors,
    REQUIRED_FOOTER_LINKS,
    "CONTENT_ARTIFACT_NAVIGATION",
    "production footer 链接集合或顺序不属于固定 M0 页脚。",
    sourcePath,
  );
  if (/(?:公安|公网安备|网安备案)/u.test(visibleFragmentText(body, sourcePath))) {
    failContentBuild(
      "CONTENT_ARTIFACT_PUBLIC_COPY",
      "公安联网备案现场核验前不得显示占位文本。",
      {sourcePath},
    );
  }
}

function assertPageProjection(
  html: string,
  route: string,
  content: LoadedValidatedContent,
  articles: readonly PublicArticleProjection[],
  expected: ArtifactPageExpectation,
  sourcePath: string,
): void {
  assertHtmlLanguage(html, sourcePath);
  assertPageMetadata(html, expected, sourcePath);
  assertGlobalChrome(html, sourcePath);
  const body = extractUniqueElementInnerHtml(html, "body", sourcePath);
  assertNoUnapprovedPublicActions(body, content, sourcePath);
  const main = extractUniqueElementInnerHtml(body, "main", sourcePath);
  const h1 = extractUniqueElementInnerHtml(main, "h1", sourcePath);
  if (visibleFragmentText(h1, sourcePath) !== expected.h1) {
    failContentBuild(
      "CONTENT_ARTIFACT_H1",
      "production 页面 H1 与安全页面投影不一致。",
      {sourcePath},
    );
  }
  if (route === "/") {
    assertHomeProjection(main, sourcePath);
    return;
  }
  if (route === "/projects/") {
    assertProjectsIndexProjection(main, content, sourcePath);
    return;
  }
  if (route === "/writing/") {
    assertWritingIndexProjection(main, content, articles, sourcePath);
    return;
  }
  const project = content.projectNavigation.find((item) => item.canonicalPath === route);
  if (project !== undefined) {
    assertProjectProjection(main, project, sourcePath, {
      requireRelations: true,
      requireSelfLink: false,
    });
    return;
  }
  const article = articles.find((item) => item.canonicalPath === route);
  if (article !== undefined) {
    assertArticleProjection(main, article, sourcePath, {
      requireRelations: true,
      requireSelfLink: false,
      requireSummary: false,
    });
    return;
  }
  failContentBuild(
    "CONTENT_ARTIFACT_ROUTE_SET",
    "production HTML 路由不属于公开页面投影。",
    {sourcePath},
  );
}

function parseSitemap(xml: string): readonly string[] {
  if (
    xml.includes("<!--")
    || xml.includes("<![CDATA[")
    || /<!DOCTYPE(?=[\t\n\r >])/iu.test(xml)
  ) {
    failContentBuild("CONTENT_ARTIFACT_SITEMAP", "sitemap.xml 结构不属于受控 URL 集。", {
      sourcePath: "build/sitemap.xml",
    });
  }
  const declaration = [
    "<?xml version=\"1.0\"?>",
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
  ].find((candidate) => xml.startsWith(candidate));
  if (declaration === undefined) {
    failContentBuild("CONTENT_ARTIFACT_SITEMAP", "sitemap.xml 缺少受控 XML 声明。", {
      sourcePath: "build/sitemap.xml",
    });
  }
  let cursor = declaration.length;
  while (/[\t\n\r ]/u.test(xml[cursor] ?? "")) cursor += 1;
  if (!xml.startsWith("<urlset", cursor)) {
    failContentBuild("CONTENT_ARTIFACT_SITEMAP", "sitemap.xml 缺少 urlset 根。", {
      sourcePath: "build/sitemap.xml",
    });
  }
  const rootOpeningEnd = htmlTagEnd(xml, cursor, "build/sitemap.xml");
  const rootOpening = xml.slice(cursor, rootOpeningEnd + 1);
  const docusaurusRoot = "<urlset"
    + " xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\""
    + " xmlns:news=\"http://www.google.com/schemas/sitemap-news/0.9\""
    + " xmlns:xhtml=\"http://www.w3.org/1999/xhtml\""
    + " xmlns:image=\"http://www.google.com/schemas/sitemap-image/1.1\""
    + " xmlns:video=\"http://www.google.com/schemas/sitemap-video/1.1\">";
  if (rootOpening !== "<urlset>" && rootOpening !== docusaurusRoot) {
    failContentBuild("CONTENT_ARTIFACT_SITEMAP", "sitemap.xml 的 urlset 根不规范。", {
      sourcePath: "build/sitemap.xml",
    });
  }
  const rootClosing = xml.lastIndexOf("</urlset>");
  if (
    rootClosing < rootOpeningEnd
    || !/^[\t\n\r ]*$/u.test(xml.slice(rootClosing + "</urlset>".length))
  ) {
    failContentBuild("CONTENT_ARTIFACT_SITEMAP", "sitemap.xml 的 urlset 根未正确闭合。", {
      sourcePath: "build/sitemap.xml",
    });
  }
  const body = xml.slice(rootOpeningEnd + 1, rootClosing);
  const values: string[] = [];
  cursor = 0;
  while (cursor < body.length) {
    while (/[\t\n\r ]/u.test(body[cursor] ?? "")) cursor += 1;
    if (cursor === body.length) break;
    if (!body.startsWith("<url>", cursor)) {
      failContentBuild("CONTENT_ARTIFACT_SITEMAP", "sitemap.xml 含非受控 url 成员。", {
        sourcePath: "build/sitemap.xml",
      });
    }
    const urlClosing = body.indexOf("</url>", cursor + "<url>".length);
    if (urlClosing < 0) {
      failContentBuild("CONTENT_ARTIFACT_SITEMAP", "sitemap.xml 的 url 成员未正确闭合。", {
        sourcePath: "build/sitemap.xml",
      });
    }
    const urlBody = body.slice(cursor + "<url>".length, urlClosing);
    let urlCursor = 0;
    let location: string | undefined;
    const seenChildren = new Set<string>();
    while (urlCursor < urlBody.length) {
      while (/[\t\n\r ]/u.test(urlBody[urlCursor] ?? "")) urlCursor += 1;
      if (urlCursor === urlBody.length) break;
      const child = /^<(loc|lastmod|changefreq|priority)>([^<]*)<\/\1>/u.exec(
        urlBody.slice(urlCursor),
      );
      if (child === null || seenChildren.has(child[1] ?? "")) {
        failContentBuild("CONTENT_ARTIFACT_SITEMAP", "sitemap.xml 的 url 子元素不规范。", {
          sourcePath: "build/sitemap.xml",
        });
      }
      const name = child[1] ?? "";
      const value = child[2] ?? "";
      if (
        /[&<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u0084\u0086-\u009f]/u.test(value)
        || value.includes("]]>")
        || (name === "changefreq" && ![
          "always", "hourly", "daily", "weekly", "monthly", "yearly", "never",
        ].includes(value))
        || (name === "priority" && !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u.test(value))
        || (name === "lastmod" && !/^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/u.test(value))
      ) {
        failContentBuild("CONTENT_ARTIFACT_SITEMAP", "sitemap.xml 的 url 子元素值不规范。", {
          sourcePath: "build/sitemap.xml",
        });
      }
      seenChildren.add(name);
      if (name === "loc") location = value;
      urlCursor += child[0].length;
    }
    if (location === undefined || location.length === 0 || /[&<>]/u.test(location)) {
      failContentBuild("CONTENT_ARTIFACT_SITEMAP", "sitemap.xml 的 loc 缺失或不规范。", {
        sourcePath: "build/sitemap.xml",
      });
    }
    values.push(location);
    cursor = urlClosing + "</url>".length;
  }
  if (values.length === 0 || new Set(values).size !== values.length) {
    failContentBuild("CONTENT_ARTIFACT_SITEMAP", "sitemap.xml URL 集为空或重复。", {
      sourcePath: "build/sitemap.xml",
    });
  }
  return values.sort();
}

function navigationLabel(
  item: Readonly<{title: string; publicationStatus: string}>,
): string {
  return item.publicationStatus === "archived"
    ? `${item.title}（归档）`
    : item.title;
}

function expectedProjectSidebar(content: LoadedValidatedContent): readonly SidebarLink[] {
  return Object.freeze(content.projectNavigation.map((item) => Object.freeze({
    href: item.canonicalPath,
    label: navigationLabel(item),
  })));
}

function expectedWritingSidebar(content: LoadedValidatedContent): readonly SidebarLink[] {
  const links: SidebarLink[] = [];
  for (const group of content.writingNavigation) {
    if (group.kind === "draft") {
      failContentBuild(
        "CONTENT_ARTIFACT_SIDEBAR_MODEL",
        "production 导航投影不得包含草稿侧栏组。",
        {sourcePath: "site-content/writing"},
      );
    }
    if (group.kind === "general") {
      links.push(...group.articles.map((item) => Object.freeze({
        href: item.canonicalPath,
        label: navigationLabel(item),
      })));
      continue;
    }
    links.push(...group.rootArticles.map((item) => Object.freeze({
      href: item.canonicalPath,
      label: navigationLabel(item),
    })));
    for (const module of group.modules) {
      links.push(...module.articles.map((item) => Object.freeze({
        href: item.canonicalPath,
        label: navigationLabel(item),
      })));
    }
  }
  return Object.freeze(links);
}

function assertSidebarProjection(
  html: string,
  expected: readonly SidebarLink[],
  sourcePath: string,
): void {
  const actual = extractSidebarLinks(html, sourcePath);
  if (
    actual.length !== expected.length
    || actual.some((link, index) => {
      const candidate = expected[index];
      return candidate === undefined
        || link.href !== candidate.href
        || link.label !== candidate.label;
    })
  ) {
    failContentBuild(
      "CONTENT_ARTIFACT_SIDEBAR_SET",
      "公开详情页文档侧栏与唯一导航投影不一致。",
      {sourcePath},
    );
  }
}

export function canonicalArticleDateIndex(content: LoadedValidatedContent): string {
  return `${JSON.stringify(content.articleDateIndex, null, 2)}\n`;
}

function privateDateIndexPath(generatedFilesDirectory: string): string {
  if (
    !isAbsolute(generatedFilesDirectory)
    || resolve(generatedFilesDirectory) !== generatedFilesDirectory
  ) {
    failContentBuild(
      "CONTENT_ARTIFACT_PRIVATE_INDEX",
      "Docusaurus generated files 根必须是规范绝对路径。",
      {sourcePath: ARTICLE_DATE_INDEX_RELATIVE_PATH},
    );
  }
  let realRoot: string;
  try {
    const metadata = lstatSync(generatedFilesDirectory, {bigint: true});
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new TypeError("generated files root is not a real directory");
    }
    realRoot = realpathSync(generatedFilesDirectory);
  } catch (error) {
    failContentBuild(
      "CONTENT_ARTIFACT_PRIVATE_INDEX",
      "Docusaurus generated files 根无法安全读取。",
      {cause: error, sourcePath: ARTICLE_DATE_INDEX_RELATIVE_PATH},
    );
  }
  if (realRoot !== generatedFilesDirectory) {
    failContentBuild(
      "CONTENT_ARTIFACT_PRIVATE_INDEX",
      "Docusaurus generated files 根不得通过符号或别名路径进入。",
      {sourcePath: ARTICLE_DATE_INDEX_RELATIVE_PATH},
    );
  }
  const privateDirectory = resolve(realRoot, "axial-muse");
  try {
    const metadata = lstatSync(privateDirectory, {bigint: true});
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || (
        typeof process.getuid === "function"
        && metadata.uid !== BigInt(process.getuid())
      )
      || realpathSync(privateDirectory) !== privateDirectory
    ) {
      throw new TypeError("private index parent is not a real owned directory");
    }
  } catch (error) {
    failContentBuild(
      "CONTENT_ARTIFACT_PRIVATE_INDEX",
      "私有日期索引父目录无法安全读取。",
      {cause: error, sourcePath: ARTICLE_DATE_INDEX_RELATIVE_PATH},
    );
  }
  const target = resolve(privateDirectory, "article-date-index.json");
  const relation = relative(realRoot, target);
  if (relation !== ARTICLE_DATE_INDEX_RELATIVE_PATH) {
    failContentBuild(
      "CONTENT_ARTIFACT_PRIVATE_INDEX",
      "私有日期索引路径逃逸 generated files 根。",
      {sourcePath: ARTICLE_DATE_INDEX_RELATIVE_PATH},
    );
  }
  try {
    if (realpathSync(target) !== target) {
      throw new TypeError("private index target uses a symbolic parent or alias");
    }
  } catch (error) {
    failContentBuild(
      "CONTENT_ARTIFACT_PRIVATE_INDEX",
      "私有日期索引真实路径不在受控父目录内。",
      {cause: error, sourcePath: ARTICLE_DATE_INDEX_RELATIVE_PATH},
    );
  }
  return target;
}

export function assertPrivateDateIndex(
  content: LoadedValidatedContent,
  generatedFilesDirectory: string,
  expectedEvidence?: BuildFileEvidence,
): BuildFileEvidence {
  const target = privateDateIndexPath(generatedFilesDirectory);
  const actual = readStableTextFile(
    target,
    ARTICLE_DATE_INDEX_RELATIVE_PATH,
    expectedEvidence,
  );
  if (privateDateIndexPath(generatedFilesDirectory) !== target) {
    failContentBuild(
      "CONTENT_ARTIFACT_PRIVATE_INDEX",
      "私有日期索引父目录在读取期间发生漂移。",
      {sourcePath: ARTICLE_DATE_INDEX_RELATIVE_PATH},
    );
  }
  if (actual !== canonicalArticleDateIndex(content)) {
    failContentBuild(
      "CONTENT_ARTIFACT_PRIVATE_INDEX",
      "私有日期索引与当前重新验证内容不一致。",
      {sourcePath: ARTICLE_DATE_INDEX_RELATIVE_PATH},
    );
  }
  const bytes = new TextEncoder().encode(actual);
  return Object.freeze({
    relativePath: ARTICLE_DATE_INDEX_RELATIVE_PATH,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  });
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function javascriptKeyPattern(value: string): string {
  const escaped = escapePattern(value);
  return `(?:${escaped}|"${escaped}"|'${escaped}')`;
}

function javascriptStringPattern(value: string): string {
  const escaped = escapePattern(value);
  return `(?:"${escaped}"|'${escaped}')`;
}

function normalizedBundleText(value: string): string {
  return value
    .replaceAll("\\\"", "\"")
    .replace(/\\u002f/giu, "/")
    .replace(/&(?:quot|#34|#x22);/giu, "\"")
    .replace(/\\(?:r\\n|n|r|t)/gu, " ");
}

function permutations<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) => permutations([
    ...values.slice(0, index),
    ...values.slice(index + 1),
  ]).map((tail) => [value, ...tail]));
}

export function hasPrivateDateIndexSignature(
  value: string,
  content: LoadedValidatedContent,
): boolean {
  if (content.articleDateIndex.length === 0) return false;
  const candidates = [value, normalizedBundleText(value)];
  return content.articleDateIndex.some((entry) => {
    const fields = [
      ["articleId", entry.articleId],
      ["slug", entry.slug],
      ["publishedAt", entry.publishedAt],
      ["updatedAt", entry.updatedAt],
    ] as const;
    return permutations(fields).some((orderedFields) => {
      const body = orderedFields.map(([key, fieldValue]) => (
        `${javascriptKeyPattern(key)}\\s*:\\s*${javascriptStringPattern(fieldValue)}`
      )).join("\\s*,\\s*");
      const pattern = new RegExp(`\\{\\s*${body}\\s*\\}`, "u");
      return candidates.some((candidate) => pattern.test(candidate));
    });
  });
}

function sameIndexSet(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export function sameTreeEvidence(left: BuildTreeEvidence, right: BuildTreeEvidence): boolean {
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

function sameFileTreeEvidence(left: BuildTreeEvidence, right: BuildTreeEvidence): boolean {
  return sameIndexSet(left.ssrImageReferenceIndexes, right.ssrImageReferenceIndexes)
    && left.files.length === right.files.length
    && left.files.every((file, index) => {
      const candidate = right.files[index];
      return candidate !== undefined
        && file.relativePath === candidate.relativePath
        && file.byteLength === candidate.byteLength
        && file.sha256 === candidate.sha256;
    });
}

function lowerPercentEscapes(value: string): string {
  return value.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase());
}

function machinePathRepresentations(value: string): readonly string[] {
  const bytes = Buffer.from(value, "utf8");
  const alignedLength = bytes.byteLength - (bytes.byteLength % 3);
  const base64 = bytes.toString("base64");
  const alignedBase64 = alignedLength === 0
    ? ""
    : bytes.subarray(0, alignedLength).toString("base64");
  const base64Url = base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  const alignedBase64Url = alignedBase64.replaceAll("+", "-").replaceAll("/", "_");
  const component = encodeURIComponent(value);
  const fileUrl = pathToFileURL(value).href;
  const baseRepresentations = [
    value,
    value.replaceAll("/", "\\/"),
    value.replaceAll("/", "\\x2f"),
    value.replaceAll("/", "\\x2F"),
    value.replaceAll("/", "\\u002f"),
    value.replaceAll("/", "\\u002F"),
    component,
    lowerPercentEscapes(component),
    encodeURIComponent(component),
    fileUrl,
    lowerPercentEscapes(fileUrl),
    encodeURIComponent(fileUrl),
    base64,
    base64.replace(/=+$/u, ""),
    base64Url,
    alignedBase64,
    alignedBase64Url,
    bytes.toString("hex"),
    bytes.toString("hex").toUpperCase(),
  ];
  const serializedRepresentations = baseRepresentations.map((candidate) => {
    const serialized = JSON.stringify(candidate);
    if (serialized === undefined) {
      failContentBuild(
        "CONTENT_ARTIFACT_MACHINE_PATH_INPUT",
        "无法建立服务端机器路径的文本表示。",
        {sourcePath: "build"},
      );
    }
    return serialized.slice(1, -1);
  });
  return Object.freeze([...new Set([
    ...baseRepresentations,
    ...serializedRepresentations,
  ])].filter((candidate) => candidate.length >= 4));
}

function machinePathPercentRepresentations(value: string): readonly string[] {
  const component = encodeURIComponent(value);
  const fileUrl = pathToFileURL(value).href;
  return Object.freeze([...new Set([
    component,
    encodeURIComponent(component),
    fileUrl,
    encodeURIComponent(fileUrl),
  ])].filter((candidate) => candidate.length >= 4));
}

function machinePathHexRepresentation(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

function isAsciiHexDigit(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39)
    || (byte >= 0x41 && byte <= 0x46)
    || (byte >= 0x61 && byte <= 0x66)
  );
}

function foldAsciiHexLetter(byte: number): number {
  return byte >= 0x41 && byte <= 0x46 ? byte + 0x20 : byte;
}

function normalizePercentEscapeCase(bytes: Uint8Array): void {
  for (let index = 0; index + 2 < bytes.byteLength; index += 1) {
    if (
      bytes[index] !== 0x25
      || !isAsciiHexDigit(bytes[index + 1])
      || !isAsciiHexDigit(bytes[index + 2])
    ) continue;
    bytes[index + 1] = foldAsciiHexLetter(bytes[index + 1]);
    bytes[index + 2] = foldAsciiHexLetter(bytes[index + 2]);
    if (
      bytes[index + 1] === 0x32
      && bytes[index + 2] === 0x35
      && index + 4 < bytes.byteLength
      && isAsciiHexDigit(bytes[index + 3])
      && isAsciiHexDigit(bytes[index + 4])
    ) {
      bytes[index + 3] = foldAsciiHexLetter(bytes[index + 3]);
      bytes[index + 4] = foldAsciiHexLetter(bytes[index + 4]);
    }
  }
}

function normalizeAsciiHexCase(bytes: Uint8Array): void {
  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = foldAsciiHexLetter(bytes[index]);
  }
}

function includesAnyToken(
  bytes: Uint8Array,
  tokens: readonly Buffer[],
): boolean {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return tokens.some((token) => view.includes(token));
}

function hasNormalizedMachinePathLeak(
  buildDirectory: string,
  baseline: BuildTreeEvidence,
  percentTokens: readonly Buffer[],
  hexTokens: readonly Buffer[],
): boolean {
  for (const file of baseline.files) {
    const bytes = readStableFileBytes(
      resolve(buildDirectory, file.relativePath),
      `build/${file.relativePath}`,
      file,
    );
    let percentView: Uint8Array | undefined;
    try {
      percentView = Uint8Array.from(bytes);
      normalizePercentEscapeCase(percentView);
      if (includesAnyToken(percentView, percentTokens)) return true;
      normalizeAsciiHexCase(bytes);
      if (includesAnyToken(bytes, hexTokens)) return true;
    } finally {
      percentView?.fill(0);
      bytes.fill(0);
    }
  }
  return false;
}

function assertNoMachinePathLeak(
  content: LoadedValidatedContent,
  buildDirectory: string,
  generatedFilesDirectory: string,
  baseline: BuildTreeEvidence,
): void {
  let temporaryRoot: string;
  try {
    temporaryRoot = realpathSync(tmpdir());
  } catch (error) {
    failContentBuild(
      "CONTENT_ARTIFACT_MACHINE_PATH_INPUT",
      "无法建立受控系统临时路径泄漏证据。",
      {cause: error, sourcePath: "build"},
    );
  }
  const values = [...new Set([
    content.repositoryRoot,
    buildDirectory,
    generatedFilesDirectory,
    resolve(temporaryRoot, "axial-muse-build-"),
  ])].sort();
  const tokens = [...new Set(values.flatMap(machinePathRepresentations))]
    .map((value) => Buffer.from(value, "utf8"));
  const percentTokens = [...new Set(values.flatMap(machinePathPercentRepresentations))]
    .map((value) => {
      const token = Buffer.from(value, "utf8");
      normalizePercentEscapeCase(token);
      return token;
    });
  const hexTokens = [...new Set(values.map(machinePathHexRepresentation))]
    .map((value) => Buffer.from(value, "utf8"));
  const allTokens = [...tokens, ...percentTokens, ...hexTokens];
  const totalTokenBytes = allTokens.reduce((total, token) => total + token.byteLength, 0);
  if (
    allTokens.length > MAX_UNPUBLISHED_CONTENT_TOKENS
    || allTokens.some((token) => token.byteLength > MAX_UNPUBLISHED_CONTENT_TOKEN_BYTES)
    || totalTokenBytes > MAX_UNPUBLISHED_CONTENT_TOKEN_TOTAL_BYTES
  ) {
    for (const token of allTokens) token.fill(0);
    failContentBuild(
      "CONTENT_ARTIFACT_MACHINE_PATH_INPUT",
      "服务端机器路径泄漏证据超过固定资源上限。",
      {sourcePath: "build"},
    );
  }
  try {
    const evidence = scanBuildTree(buildDirectory, [], tokens, []);
    if (!sameFileTreeEvidence(baseline, evidence)) {
      failContentBuild(
        "CONTENT_ARTIFACT_DRIFT",
        "production 制品在机器路径泄漏扫描期间发生漂移。",
        {sourcePath: "build"},
      );
    }
    const hasNormalizedLeak = hasNormalizedMachinePathLeak(
      buildDirectory,
      baseline,
      percentTokens,
      hexTokens,
    );
    const afterNormalizedScan = scanBuildTree(buildDirectory, [], [], []);
    if (!sameFileTreeEvidence(baseline, afterNormalizedScan)) {
      failContentBuild(
        "CONTENT_ARTIFACT_DRIFT",
        "production 制品在机器路径规范化扫描期间发生漂移。",
        {sourcePath: "build"},
      );
    }
    if (
      evidence.hasLeakedContentToken
      || hasNormalizedLeak
    ) {
      failContentBuild(
        "CONTENT_ARTIFACT_MACHINE_PATH",
        "production 制品含服务端仓库、候选或受控临时路径表示。",
        {sourcePath: "build"},
      );
    }
  } finally {
    for (const token of allTokens) token.fill(0);
  }
}

interface UnpublishedLeakTokens {
  readonly pathTokens: readonly Uint8Array[];
  readonly contentTokens: readonly Uint8Array[];
  readonly semanticTextTokens: readonly string[];
  dispose(): void;
}

function scanBuildWithLeakTokens(
  buildDirectory: string,
  tokens: UnpublishedLeakTokens,
): BuildTreeEvidence {
  const batches: Uint8Array[][] = [];
  let batch: Uint8Array[] = [];
  let batchBytes = 0;
  for (const token of tokens.contentTokens) {
    if (
      batch.length >= MAX_UNPUBLISHED_CONTENT_TOKENS
      || batchBytes + token.byteLength > MAX_UNPUBLISHED_CONTENT_TOKEN_TOTAL_BYTES
    ) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(token);
    batchBytes += token.byteLength;
  }
  if (batch.length > 0 || batches.length === 0) batches.push(batch);

  let baseline: BuildTreeEvidence | undefined;
  let hasLeakedPathToken = false;
  let hasLeakedContentToken = false;
  for (const [index, contentTokens] of batches.entries()) {
    const evidence = scanBuildTree(
      buildDirectory,
      index === 0 ? tokens.pathTokens : [],
      contentTokens,
      [],
    );
    if (baseline !== undefined && !sameFileTreeEvidence(baseline, evidence)) {
      failContentBuild(
        "CONTENT_ARTIFACT_DRIFT",
        "production 制品在未发布内容分批扫描期间发生漂移。",
        {sourcePath: "build"},
      );
    }
    baseline ??= evidence;
    hasLeakedPathToken ||= evidence.hasLeakedPathToken;
    hasLeakedContentToken ||= evidence.hasLeakedContentToken;
  }
  if (baseline === undefined) {
    failContentBuild("CONTENT_ARTIFACT_DRIFT", "production 制品未产生泄漏扫描证据。", {
      sourcePath: "build",
    });
  }
  return Object.freeze({
    files: baseline.files,
    hasLeakedPathToken,
    hasLeakedContentToken,
    hasLeakedToken: hasLeakedPathToken || hasLeakedContentToken,
    ssrImageReferenceIndexes: baseline.ssrImageReferenceIndexes,
  });
}

function contentTokenSegments(value: string): readonly string[] {
  const segments: string[] = [];
  let segment = "";
  let segmentBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (
      segmentBytes > 0
      && segmentBytes + characterBytes > MAX_UNPUBLISHED_CONTENT_TOKEN_BYTES
    ) {
      segments.push(segment);
      segment = "";
      segmentBytes = 0;
    }
    segment += character;
    segmentBytes += characterBytes;
  }
  if (segmentBytes > 0) segments.push(segment);
  return Object.freeze(segments);
}

function decodedSemanticEntities(value: string): string {
  return value
    .replace(/&(?:amp|#38|#x26);/giu, "&")
    .replace(/&(?:lt|#60|#x3c);/giu, "<")
    .replace(/&(?:gt|#62|#x3e);/giu, ">")
    .replace(/&(?:quot|#34|#x22);/giu, "\"")
    .replace(/&(?:apos|#39|#x27);/giu, "'")
    .replace(/&#(x[0-9a-f]+|[0-9]+);/giu, (_entity, digits: string) => {
      const hexadecimal = digits.toLowerCase().startsWith("x");
      const codePoint = Number.parseInt(hexadecimal ? digits.slice(1) : digits, hexadecimal ? 16 : 10);
      return Number.isSafeInteger(codePoint)
        && codePoint > 0
        && codePoint <= 0x10ffff
        && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : " ";
    })
    .replace(/&[A-Za-z][A-Za-z0-9]+;/gu, " ");
}

function normalizedSemanticText(value: string): string {
  return decodedSemanticEntities(value)
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .replace(/[\t\n\f\r ]+/gu, " ")
    .trim();
}

function markdownSemanticValues(value: string): readonly string[] {
  const stripped = value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]*>/gu, " ")
    .replace(/\\([\\*_[\]{}()#+.!~-])/gu, "$1")
    .replace(/[*_~]/gu, "");
  const decoded = decodedSemanticEntities(stripped)
    .replace(/[\t\n\f\r ]+/gu, " ")
    .trim();
  const normalized = normalizedSemanticText(stripped);
  const lexical = (normalized.match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) ?? [])
    .filter((candidate) => (
      Buffer.byteLength(candidate, "utf8") >= MIN_UNPUBLISHED_SEMANTIC_FRAGMENT_BYTES
    ));
  return Object.freeze([decoded, normalized, ...lexical].filter((candidate) => candidate !== ""));
}

export function visibleHtmlSemanticText(html: string): string {
  const withBlockBoundaries = html.replace(
    /<\/?(?:address|article|aside|blockquote|body|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|html|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)(?=[\t\n\f\r />])[^>]*>/giu,
    " ",
  );
  return normalizedSemanticText(withBlockBoundaries.replace(/<[^>]*>/gu, ""));
}

function nestedStringValues(value: unknown): readonly string[] {
  const strings: string[] = [];
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (typeof candidate === "string") {
      strings.push(candidate);
    } else if (typeof candidate === "object" && candidate !== null && !visited.has(candidate)) {
      visited.add(candidate);
      pending.push(...(Array.isArray(candidate) ? candidate : Object.values(candidate)));
    }
  }
  return Object.freeze(strings);
}

function renderedHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#x27;");
}

function markdownDestinations(value: string): readonly string[] {
  const destinations: string[] = [];
  const inline = /!?\[[^\]\\\n]*\]\(\s*(?:<([^<>\n]+)>|([^()\s\n]+))(?:[\t ]+(?:\x22[^\x22\n]*\x22|\x27[^\x27\n]*\x27|\([^()\n]*\)))?\s*\)/gu;
  for (const match of value.matchAll(inline)) {
    destinations.push(match[1] ?? match[2] ?? "");
  }
  const definition = /^ {0,3}\[[^\]\\\n]+\]:[\t ]*(?:<([^<>\n]+)>|([^\s<>\n]+))(?:[\t ]+(?:\x22[^\x22\n]*\x22|\x27[^\x27\n]*\x27|\([^()\n]*\)))?[\t ]*$/gmu;
  for (const match of value.matchAll(definition)) {
    destinations.push(match[1] ?? match[2] ?? "");
  }
  return Object.freeze(destinations.filter((candidate) => candidate !== ""));
}

function unpublishedTokens(content: LoadedValidatedContent): UnpublishedLeakTokens {
  const encoder = new TextEncoder();
  const pathValues = new Set<string>();
  const contentValues = new Set<string>();
  const semanticTextValues = new Set<string>();
  const publicArtifactValues = [
    ...Object.values(STATIC_PAGE_METADATA).flatMap((metadata) => Object.values(metadata)),
    PROJECT_EMPTY_STATE,
    WRITING_EMPTY_STATE,
    ...Object.values(PROJECT_STATUS_LABELS),
    ...Object.values(ARTICLE_STATUS_LABELS),
    ...REQUIRED_GLOBAL_LINKS.flatMap((link) => [link.href, link.label]),
    ...REQUIRED_HOME_LINKS.flatMap((link) => [link.href, link.label]),
    ...REQUIRED_FOOTER_LINKS.flatMap((link) => [link.href, link.label]),
  ];
  const publicSourcePaths = new Set([
    ...content.projectNavigation.map((project) => project.sourcePath),
    ...content.articles
      .filter((article) => article.publicationStatus !== "draft")
      .map((article) => article.sourcePath),
  ]);
  const publicCorpus = [
    ...content.sources
      .filter((source) => publicSourcePaths.has(source.sourcePath))
      .flatMap((source) => [source.fileContent, source.content]),
    JSON.stringify(content.catalog.projects.filter((project) => (
      ["published", "archived"].includes(project.publicationStatus)
    ))),
    JSON.stringify(content.articles.filter((article) => article.publicationStatus !== "draft")),
    ...publicArtifactValues,
  ];
  const publicStructuredValues = [
    ...content.catalog.projects.filter((project) => (
      ["published", "archived"].includes(project.publicationStatus)
    )),
    ...content.articles.filter((article) => article.publicationStatus !== "draft"),
  ].flatMap((value) => nestedStringValues(value));
  const publicSemanticCorpus = [
    ...content.sources
      .filter((source) => publicSourcePaths.has(source.sourcePath))
      .flatMap((source) => source.content.split(/\r?\n/u))
      .flatMap((line) => markdownSemanticValues(
        line.trim().replace(/^(?:#{1,6}|[-+*>]|\d+\.)\s+/u, ""),
      )),
    ...publicStructuredValues.flatMap((value) => [
      decodedSemanticEntities(value),
      normalizedSemanticText(value),
    ]),
    ...publicArtifactValues.flatMap((value) => [
      decodedSemanticEntities(value),
      normalizedSemanticText(value),
    ]),
  ].filter((value) => value !== "");
  const addContentValue = (value: string): boolean => {
    let retained = false;
    for (const segment of contentTokenSegments(value)) {
      if (
        Buffer.byteLength(segment, "utf8") >= 8
        && !publicCorpus.some((candidate) => candidate.includes(segment))
      ) {
        contentValues.add(segment);
        retained = true;
      }
    }
    return retained;
  };
  const addSemanticValue = (value: string): boolean => {
    let retained = false;
    for (const segment of contentTokenSegments(value)) {
      if (
        Buffer.byteLength(segment, "utf8") >= MIN_UNPUBLISHED_SEMANTIC_FRAGMENT_BYTES
        && !publicSemanticCorpus.some((candidate) => candidate.includes(segment))
      ) {
        contentValues.add(segment);
        semanticTextValues.add(segment);
        retained = true;
      }
    }
    return retained;
  };
  const addStructuredValue = (value: unknown): void => {
    for (const candidate of nestedStringValues(value)) {
      const retained = addContentValue(candidate);
      if (!retained) continue;
      addContentValue(renderedHtmlText(candidate));
      addSemanticValue(decodedSemanticEntities(candidate));
      addSemanticValue(normalizedSemanticText(candidate));
    }
  };
  const addSourceEvidence = (source: LoadedValidatedContent["sources"][number]): void => {
    const sourceBytes = Buffer.from(source.fileContent, "utf8");
    const prefixLength = sourceBytes.byteLength <= 192
      ? sourceBytes.byteLength
      : 192;
    addContentValue(sourceBytes.subarray(0, prefixLength).toString("base64"));
    let hasDistinctBodyEvidence = false;
    for (const destination of markdownDestinations(source.content)) {
      const retainedDestination = addContentValue(destination);
      hasDistinctBodyEvidence = hasDistinctBodyEvidence || (
        retainedDestination
        && Buffer.byteLength(destination, "utf8") >= MIN_UNPUBLISHED_SEMANTIC_FRAGMENT_BYTES
      );
    }
    for (const line of source.content.split(/\r?\n/u)) {
      const trimmed = line.trim();
      const retainedLine = addContentValue(trimmed);
      hasDistinctBodyEvidence = hasDistinctBodyEvidence || (
        retainedLine
        && Buffer.byteLength(trimmed, "utf8") >= MIN_UNPUBLISHED_SEMANTIC_FRAGMENT_BYTES
      );
      for (const semantic of markdownSemanticValues(
        trimmed.replace(/^(?:#{1,6}|[-+*>]|\d+\.)\s+/u, ""),
      )) {
        const retainedSemantic = addSemanticValue(semantic);
        hasDistinctBodyEvidence = hasDistinctBodyEvidence || (
          retainedSemantic
          && Buffer.byteLength(semantic, "utf8") >= MIN_UNPUBLISHED_SEMANTIC_FRAGMENT_BYTES
        );
      }
    }
    if (!hasDistinctBodyEvidence) {
      failContentBuild(
        "CONTENT_ARTIFACT_UNPUBLISHED_EVIDENCE",
        "未发布正文缺少可与公开语料区分的最小泄漏证据。",
        {sourcePath: source.sourcePath},
      );
    }
  };
  for (const project of content.catalog.projects) {
    if (!["published", "archived"].includes(project.publicationStatus)) {
      pathValues.add(`/projects/${project.slug}/`);
      const source = content.sources.find((entry) => entry.projectId === project.id);
      if (source !== undefined) {
        pathValues.add(source.sourcePath);
        addSourceEvidence(source);
      }
      for (const [field, value] of Object.entries(project)) {
        if (field === "showcaseMode") continue;
        addStructuredValue(value);
      }
    }
  }
  for (const article of content.articles) {
    if (article.publicationStatus === "draft") {
      pathValues.add(`${article.slug}/`);
      pathValues.add(article.sourcePath);
      addStructuredValue(article);
      const source = content.sources.find((entry) => entry.sourceName === article.sourceName);
      if (source !== undefined) addSourceEvidence(source);
    }
  }
  const pathTokens = Object.freeze([...pathValues]
    .filter((value) => value.length >= 4)
    .sort()
    .map((value) => encoder.encode(value)));
  const contentTokens = Object.freeze([...contentValues]
    .sort()
    .map((value) => encoder.encode(value)));
  const semanticTextTokens = Object.freeze([...semanticTextValues].sort());
  let disposed = false;
  return Object.freeze({
    pathTokens,
    contentTokens,
    semanticTextTokens,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const token of pathTokens) token.fill(0);
      for (const token of contentTokens) token.fill(0);
    },
  });
}

export function assertProductionArtifact(
  content: LoadedValidatedContent,
  staticPlan: StaticAssetPlan,
  buildDirectory: string,
  generatedFilesDirectory: string,
): void {
  const privateIndexEvidence = assertPrivateDateIndex(
    content,
    generatedFilesDirectory,
  );
  staticPlan.assertProductionBuild(buildDirectory);
  const leakTokens = unpublishedTokens(content);
  try {
    const evidence = scanBuildWithLeakTokens(buildDirectory, leakTokens);
    assertNoMachinePathLeak(
      content,
      buildDirectory,
      generatedFilesDirectory,
      evidence,
    );
    if (evidence.hasLeakedToken) {
      failContentBuild("CONTENT_ARTIFACT_UNPUBLISHED", "production 制品含未发布内容标识或正文。", {
        sourcePath: "build",
      });
    }
    if (evidence.files.some((file) => (
      file.relativePath.toLowerCase().includes("article-date-index")
    ))) {
      failContentBuild("CONTENT_ARTIFACT_PRIVATE_INDEX", "私有日期索引进入 production 制品。", {
        sourcePath: "build",
      });
    }
    const evidenceByPath = new Map(
      evidence.files.map((file) => [file.relativePath, file]),
    );
    for (const file of evidence.files) {
      const bytes = readStableFileBytes(
        resolve(buildDirectory, file.relativePath),
        `build/${file.relativePath}`,
        file,
      );
      try {
        if (hasPrivateDateIndexSignature(Buffer.from(bytes).toString("latin1"), content)) {
          failContentBuild(
            "CONTENT_ARTIFACT_PRIVATE_INDEX",
            "私有日期索引结构进入最终制品文件。",
            {sourcePath: `build/${file.relativePath}`},
          );
        }
      } finally {
        bytes.fill(0);
      }
    }
    const expected = expectedRoutes(content);
    const expectedRouteSet = new Set(expected);
    const articles = publicArticleProjections(content);
    const projectSidebar = expectedProjectSidebar(content);
    const writingSidebar = expectedWritingSidebar(content);
    const projectDetailRoutes = new Set(projectSidebar.map((link) => link.href));
    const writingDetailRoutes = new Set(writingSidebar.map((link) => link.href));
    if ([...projectDetailRoutes].some((route) => writingDetailRoutes.has(route))) {
      failContentBuild(
        "CONTENT_ARTIFACT_SIDEBAR_MODEL",
        "项目与技术文章导航投影存在跨栏 route。",
        {sourcePath: "site-content"},
      );
    }
    const runtimeRedirects = deriveProductionRuntimeRedirects(
      content.repositoryRoot,
      buildDirectory,
    );
    const actual = [...runtimeRedirects.publicRoutes];
    for (const route of actual) {
      const relativePath = route === "/"
        ? "index.html"
        : `${route.slice(1)}index.html`;
      const file = evidenceByPath.get(relativePath);
      if (file === undefined) {
        failContentBuild(
          "CONTENT_ARTIFACT_ROUTE_SET",
          "运行时公开路由无法一一映射到已复核的 HTML 文件。",
          {sourcePath: `build/${relativePath}`},
        );
      }
      const sourcePath = `build/${file.relativePath}`;
      const html = readStableTextFile(
        resolve(buildDirectory, file.relativePath),
        sourcePath,
        file,
      );
      const activeHtml = activeHtmlMarkup(html, sourcePath);
      const visibleSemantic = visibleHtmlSemanticText(activeHtml);
      if (leakTokens.semanticTextTokens.some((token) => visibleSemantic.includes(token))) {
        failContentBuild(
          "CONTENT_ARTIFACT_UNPUBLISHED",
          "production HTML 含变换后的未发布正文语义。",
          {sourcePath},
        );
      }
      assertProductionIndexing(activeHtml, sourcePath);
      if (!expectedRouteSet.has(route)) continue;
      assertCanonical(activeHtml, route, sourcePath);
      if (projectDetailRoutes.has(route)) {
        assertSidebarProjection(activeHtml, projectSidebar, sourcePath);
      } else if (writingDetailRoutes.has(route)) {
        assertSidebarProjection(activeHtml, writingSidebar, sourcePath);
      }
      assertPageProjection(
        activeHtml,
        route,
        content,
        articles,
        expectedPageExpectation(content, route, articles),
        sourcePath,
      );
    }
    if (
      actual.length !== expected.length
      || actual.some((route, index) => route !== expected[index])
    ) {
      failContentBuild("CONTENT_ARTIFACT_ROUTE_SET", "production HTML 路由集合与唯一投影不一致。", {
        sourcePath: "build",
      });
    }
    const sitemapEvidence = evidenceByPath.get("sitemap.xml");
    if (sitemapEvidence === undefined) {
      failContentBuild("CONTENT_ARTIFACT_SITEMAP", "production 制品缺少 sitemap.xml。", {
        sourcePath: "build/sitemap.xml",
      });
    }
    const sitemap = parseSitemap(readStableTextFile(
      resolve(buildDirectory, "sitemap.xml"),
      "build/sitemap.xml",
      sitemapEvidence,
    ));
    const expectedUrls = expected.map((route) => `${CANONICAL_ORIGIN}${route}`).sort();
    if (
      sitemap.length !== expectedUrls.length
      || sitemap.some((url, index) => url !== expectedUrls[index])
    ) {
      failContentBuild("CONTENT_ARTIFACT_SITEMAP_SET", "sitemap 与实际公开规范路由集合不一致。", {
        sourcePath: "build/sitemap.xml",
      });
    }
    staticPlan.assertProductionBuild(buildDirectory);
    const finalEvidence = scanBuildWithLeakTokens(buildDirectory, leakTokens);
    if (!sameTreeEvidence(evidence, finalEvidence)) {
      failContentBuild(
        "CONTENT_ARTIFACT_DRIFT",
        "production 制品在内容解析与终态扫描之间发生漂移。",
        {sourcePath: "build"},
      );
    }
    assertPrivateDateIndex(
      content,
      generatedFilesDirectory,
      privateIndexEvidence,
    );
  } finally {
    leakTokens.dispose();
  }
}
