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

const CANONICAL_ORIGIN = "https://www.axialmuse.com";
export const ARTICLE_DATE_INDEX_RELATIVE_PATH = "axial-muse/article-date-index.json";
const MIN_UNPUBLISHED_SEMANTIC_FRAGMENT_BYTES = 16;
const UTF8_DECODER = new TextDecoder("utf-8", {fatal: true});

function hasOnlyHtmlWhitespace(value: string): boolean {
  return /^[\t\n\f\r ]*$/u.test(value);
}

interface SidebarLink {
  readonly href: string;
  readonly label: string;
}

function expectedPageRoutes(repositoryRoot: string): readonly string[] {
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

function routeFromHtmlPath(path: string): string | undefined {
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

function readStableTextFile(
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

function activeHtmlMarkup(html: string, sourcePath: string): string {
  let cursor = 0;
  let sanitized = "";
  let doctypeSeen = false;
  let inRawHead = false;
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
      cursor = (inertClosing.index ?? end + 1) + inertClosing[0].length;
      continue;
    }
    sanitized += sanitizeHtmlTag(tag);
    cursor = end + 1;
  }
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

function htmlAttributes(tag: string, sourcePath: string): ReadonlyMap<string, string> {
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
  tagName: "aside" | "ul",
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
  if (openings.length !== 1 || openings[0]?.index === undefined) {
    failContentBuild(
      "CONTENT_ARTIFACT_SIDEBAR_STRUCTURE",
      "公开详情页必须包含唯一 Docusaurus 文档侧栏容器。",
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
    "CONTENT_ARTIFACT_SIDEBAR_STRUCTURE",
    "Docusaurus 文档侧栏容器未正确闭合。",
    {sourcePath},
  );
}

function decodeHtmlText(value: string, sourcePath: string): string {
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
      "CONTENT_ARTIFACT_SIDEBAR_STRUCTURE",
      "Docusaurus 文档侧栏含无法确定解码的 HTML entity。",
      {sourcePath},
    );
  }
  return decoded;
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

function extractSidebarLinks(html: string, sourcePath: string): readonly SidebarLink[] {
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

function assertCanonical(html: string, route: string, sourcePath: string): void {
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
  if (
    headTags.some((tag) => !/^<(?:link|meta)(?=[\t\n\f\r />])[^>]*>$/iu.test(tag))
    || !hasOnlyHtmlWhitespace(
      head.replace(/<(?:link|meta)(?=[\t\n\f\r />])[^>]*>/giu, ""),
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

function assertPrivateDateIndex(
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

function hasPrivateDateIndexSignature(
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

function sameTreeEvidence(left: BuildTreeEvidence, right: BuildTreeEvidence): boolean {
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

function visibleHtmlSemanticText(html: string): string {
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
      addStructuredValue(project);
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
    if (evidence.files.some((file) => {
      const lower = file.relativePath.toLowerCase();
      return (lower.endsWith(".html") && !file.relativePath.endsWith(".html"))
        || lower.endsWith(".htm")
        || lower.endsWith(".xhtml");
    })) {
      failContentBuild(
        "CONTENT_ARTIFACT_ROUTE_SET",
        "production 制品含不受控的 HTML 后缀。",
        {sourcePath: "build"},
      );
    }
    const htmlFiles = evidence.files.filter((file) => file.relativePath.endsWith(".html"));
    const actual: string[] = [];
    for (const file of htmlFiles) {
      const route = routeFromHtmlPath(file.relativePath);
      if (route === undefined) continue;
      actual.push(route);
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
      if (projectDetailRoutes.has(route)) {
        assertCanonical(activeHtml, route, sourcePath);
        assertSidebarProjection(activeHtml, projectSidebar, sourcePath);
      } else if (writingDetailRoutes.has(route)) {
        assertCanonical(activeHtml, route, sourcePath);
        assertSidebarProjection(activeHtml, writingSidebar, sourcePath);
      }
    }
    actual.sort();
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
