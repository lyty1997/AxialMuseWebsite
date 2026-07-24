const RAW_TEXT_ELEMENT_NAMES = new Set([
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
const HTML_VOID_ELEMENT_NAMES = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const DISCARDING_CONTEXT_NAMES = new Set(["frameset", "select"]);
const FOREIGN_ROOT_NAMES = new Set(["math", "svg"]);
const MAX_TRACKED_ELEMENT_DEPTH = 4_096;

interface TagName {
  readonly name: string;
  readonly end: number;
}

interface TrackedElement {
  readonly name: string;
  readonly blocksImageReference: boolean;
  readonly startsForeignContent: boolean;
}

function isHtmlWhitespace(character: string | undefined): boolean {
  return character === " "
    || character === "\t"
    || character === "\n"
    || character === "\r"
    || character === "\f";
}

function isAsciiAlpha(character: string | undefined): boolean {
  if (character === undefined) return false;
  const codePoint = character.charCodeAt(0);
  return (codePoint >= 0x41 && codePoint <= 0x5a)
    || (codePoint >= 0x61 && codePoint <= 0x7a);
}

function asciiLowerCase(value: string): string {
  return [...value].map((character) => {
    const codePoint = character.charCodeAt(0);
    return codePoint >= 0x41 && codePoint <= 0x5a
      ? String.fromCharCode(codePoint + 0x20)
      : character;
  }).join("");
}

function readTagName(html: string, start: number): TagName | undefined {
  if (!isAsciiAlpha(html[start])) return undefined;
  let end = start + 1;
  while (
    end < html.length
    && !isHtmlWhitespace(html[end])
    && html[end] !== "/"
    && html[end] !== ">"
  ) end += 1;
  return {
    name: asciiLowerCase(html.slice(start, end)),
    end,
  };
}

function findTagEnd(html: string, start: number): number {
  let quote: "\"" | "'" | undefined;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function isSelfClosingTag(html: string, tagStart: number, tagEnd: number): boolean {
  let index = tagEnd - 1;
  while (index > tagStart && isHtmlWhitespace(html[index])) index -= 1;
  return html[index] === "/";
}

function popTrackedElement(
  elements: TrackedElement[],
  name: string,
): Readonly<{blockedDepth: number; foreignDepth: number}> {
  let match = elements.length - 1;
  while (match >= 0 && elements[match]?.name !== name) match -= 1;
  if (match < 0) return {blockedDepth: 0, foreignDepth: 0};
  for (let index = elements.length - 1; index > match; index -= 1) {
    if (
      elements[index]?.blocksImageReference
      || elements[index]?.startsForeignContent
    ) return {blockedDepth: 0, foreignDepth: 0};
  }
  let blockedDepth = 0;
  let foreignDepth = 0;
  for (let index = elements.length - 1; index >= match; index -= 1) {
    if (elements[index]?.blocksImageReference) blockedDepth += 1;
    if (elements[index]?.startsForeignContent) foreignDepth += 1;
  }
  elements.length = match;
  return {blockedDepth, foreignDepth};
}

function indexOfAsciiCaseInsensitive(
  value: string,
  search: string,
  start: number,
): number {
  const foldedSearch = asciiLowerCase(search);
  for (let index = start; index <= value.length - search.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < search.length; offset += 1) {
      const codePoint = value.charCodeAt(index + offset);
      const folded = codePoint >= 0x41 && codePoint <= 0x5a
        ? String.fromCharCode(codePoint + 0x20)
        : value[index + offset];
      if (folded !== foldedSearch[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  return -1;
}

function isEndTagNameDelimiter(character: string | undefined): boolean {
  return character === "/"
    || character === ">"
    || isHtmlWhitespace(character);
}

function findRawTextClosingEnd(
  html: string,
  name: string,
  start: number,
): number {
  const marker = `</${name}`;
  let searchStart = start;
  while (searchStart < html.length) {
    const closingStart = indexOfAsciiCaseInsensitive(html, marker, searchStart);
    if (closingStart === -1) return -1;
    const nameEnd = closingStart + marker.length;
    if (isEndTagNameDelimiter(html[nameEnd])) {
      return findTagEnd(html, nameEnd);
    }
    searchStart = nameEnd;
  }
  return -1;
}

function startsWithAppropriateScriptName(
  html: string,
  start: number,
  prefix: "<script" | "</script",
): boolean {
  if (start < 0 || start + prefix.length > html.length) return false;
  for (let offset = 0; offset < prefix.length; offset += 1) {
    const codePoint = html.charCodeAt(start + offset);
    const folded = codePoint >= 0x41 && codePoint <= 0x5a
      ? String.fromCharCode(codePoint + 0x20)
      : html[start + offset];
    if (folded !== prefix[offset]) return false;
  }
  return isEndTagNameDelimiter(html[start + prefix.length]);
}

function findScriptClosingEnd(html: string, start: number): number {
  let state: "data" | "escaped" | "double-escaped" = "data";
  let index = start;
  while (index < html.length) {
    if (state === "data") {
      if (html.startsWith("<!--", index)) {
        state = "escaped";
        index += 4;
        continue;
      }
      if (startsWithAppropriateScriptName(html, index, "</script")) {
        return findTagEnd(html, index + "</script".length);
      }
    } else if (state === "escaped") {
      if (html.startsWith("-->", index)) {
        state = "data";
        index += 3;
        continue;
      }
      if (startsWithAppropriateScriptName(html, index, "</script")) {
        return findTagEnd(html, index + "</script".length);
      }
      if (startsWithAppropriateScriptName(html, index, "<script")) {
        state = "double-escaped";
        index += "<script".length;
        continue;
      }
    } else {
      if (html.startsWith("-->", index)) {
        state = "data";
        index += 3;
        continue;
      }
      if (startsWithAppropriateScriptName(html, index, "</script")) {
        state = "escaped";
        index += "</script".length;
        continue;
      }
    }
    index += 1;
  }
  return -1;
}

function isValidSrcsetDescriptor(value: string): boolean {
  const components = value.trim() === ""
    ? []
    : value.trim().split(/[\t\n\f\r ]+/u);
  if (components.length === 0) return true;
  if (components.length !== 1) return false;
  const descriptor = components[0];
  if (/^[0-9]+w$/u.test(descriptor)) {
    const width = Number(descriptor.slice(0, -1));
    return Number.isSafeInteger(width) && width > 0;
  }
  if (/^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)x$/u.test(descriptor)) {
    const density = Number(descriptor.slice(0, -1));
    return Number.isFinite(density) && density > 0;
  }
  return false;
}

function srcsetCandidateUrls(value: string): readonly string[] {
  const urls: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (isHtmlWhitespace(value[index]) || value[index] === ",") index += 1;
    if (index >= value.length) break;

    const urlStart = index;
    while (index < value.length && !isHtmlWhitespace(value[index])) index += 1;
    let url = value.slice(urlStart, index);
    if (url.endsWith(",")) {
      url = url.replace(/,+$/u, "");
      if (url !== "") urls.push(url);
      continue;
    }

    const descriptorStart = index;
    let parenthesesDepth = 0;
    while (index < value.length) {
      const character = value[index];
      if (character === "(") parenthesesDepth += 1;
      if (character === ")" && parenthesesDepth > 0) parenthesesDepth -= 1;
      if (character === "," && parenthesesDepth === 0) break;
      index += 1;
    }
    if (isValidSrcsetDescriptor(value.slice(descriptorStart, index))) urls.push(url);
    if (value[index] === ",") index += 1;
  }
  return urls;
}

function attributeReferenceIndexes(
  tag: string,
  attributeStart: number,
  publicUrlIndexes: ReadonlyMap<string, number>,
): ReadonlySet<number> {
  const found = new Set<number>();
  const seenAttributeNames = new Set<string>();
  let index = attributeStart;
  while (index < tag.length) {
    while (isHtmlWhitespace(tag[index]) || tag[index] === "/") index += 1;
    if (index >= tag.length || tag[index] === ">") break;

    const nameStart = index;
    while (
      index < tag.length
      && !isHtmlWhitespace(tag[index])
      && !["\"", "'", "<", ">", "/", "="].includes(tag[index])
    ) index += 1;
    if (index === nameStart) {
      index += 1;
      continue;
    }
    const name = asciiLowerCase(tag.slice(nameStart, index));
    const isDuplicate = seenAttributeNames.has(name);
    seenAttributeNames.add(name);
    while (isHtmlWhitespace(tag[index])) index += 1;
    if (tag[index] !== "=") continue;
    index += 1;
    while (isHtmlWhitespace(tag[index])) index += 1;

    let value: string;
    const quote = tag[index];
    if (quote === "\"" || quote === "'") {
      index += 1;
      const valueStart = index;
      while (index < tag.length && tag[index] !== quote) index += 1;
      if (index >= tag.length) break;
      value = tag.slice(valueStart, index);
      index += 1;
    } else {
      const valueStart = index;
      while (
        index < tag.length
        && !isHtmlWhitespace(tag[index])
        && tag[index] !== ">"
      ) index += 1;
      value = tag.slice(valueStart, index);
    }

    if (isDuplicate) continue;
    if (name === "src") {
      const referenceIndex = publicUrlIndexes.get(value);
      if (referenceIndex !== undefined) found.add(referenceIndex);
    } else if (name === "srcset") {
      for (const url of srcsetCandidateUrls(value)) {
        const referenceIndex = publicUrlIndexes.get(url);
        if (referenceIndex !== undefined) found.add(referenceIndex);
      }
    }
  }
  return found;
}

export function findSsrImageReferenceIndexes(
  html: string,
  publicUrls: readonly string[],
): ReadonlySet<number> {
  const publicUrlIndexes = new Map<string, number>();
  for (const [urlIndex, publicUrl] of publicUrls.entries()) {
    if (!publicUrlIndexes.has(publicUrl)) publicUrlIndexes.set(publicUrl, urlIndex);
  }
  const found = new Set<number>();
  const elements: TrackedElement[] = [];
  let index = 0;
  let templateDepth = 0;
  let blockedDepth = 0;
  let foreignDepth = 0;
  let imageReferencesPermanentlyBlocked = false;
  while (index < html.length) {
    const tagStart = html.indexOf("<", index);
    if (tagStart === -1) break;
    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      if (commentEnd === -1) break;
      index = commentEnd + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", tagStart)) {
      const cdataEnd = html.indexOf("]]>", tagStart + 9);
      if (cdataEnd === -1) break;
      index = cdataEnd + 3;
      continue;
    }
    if (html.startsWith("<!", tagStart) || html.startsWith("<?", tagStart)) {
      const declarationEnd = findTagEnd(html, tagStart + 2);
      if (declarationEnd === -1) break;
      index = declarationEnd + 1;
      continue;
    }

    let nameStart = tagStart + 1;
    const isClosingTag = html[nameStart] === "/";
    if (isClosingTag) nameStart += 1;
    const tagName = readTagName(html, nameStart);
    if (tagName === undefined) {
      index = tagStart + 1;
      continue;
    }
    const {name} = tagName;
    const tagEnd = findTagEnd(html, tagName.end);
    if (tagEnd === -1) break;
    if (!isClosingTag && name === "plaintext") break;
    if (!isClosingTag && RAW_TEXT_ELEMENT_NAMES.has(name)) {
      const closingEnd = name === "script"
        ? findScriptClosingEnd(html, tagEnd + 1)
        : findRawTextClosingEnd(html, name, tagEnd + 1);
      if (closingEnd === -1) break;
      index = closingEnd + 1;
      continue;
    }
    if (name === "template") {
      if (isClosingTag) {
        if (templateDepth > 0) templateDepth -= 1;
      } else {
        templateDepth += 1;
      }
      index = tagEnd + 1;
      continue;
    }
    if (templateDepth > 0) {
      index = tagEnd + 1;
      continue;
    }
    if (isClosingTag) {
      const popped = popTrackedElement(elements, name);
      blockedDepth -= popped.blockedDepth;
      foreignDepth -= popped.foreignDepth;
      index = tagEnd + 1;
      continue;
    }
    if (
      !imageReferencesPermanentlyBlocked
      && blockedDepth === 0
      && foreignDepth === 0
      && name === "img"
    ) {
      const tag = html.slice(tagStart, tagEnd + 1);
      const attributeStart = tagName.end - tagStart;
      for (const referenceIndex of attributeReferenceIndexes(
        tag,
        attributeStart,
        publicUrlIndexes,
      )) found.add(referenceIndex);
    }

    const startsForeignContent = FOREIGN_ROOT_NAMES.has(name);
    const selfClosing = isSelfClosingTag(html, tagStart, tagEnd);
    const shouldTrack = startsForeignContent
      ? !selfClosing
      : foreignDepth > 0
        ? !selfClosing
        : !HTML_VOID_ELEMENT_NAMES.has(name);
    if (shouldTrack) {
      if (elements.length >= MAX_TRACKED_ELEMENT_DEPTH) {
        found.clear();
        return found;
      }
      const blocksImageReference = DISCARDING_CONTEXT_NAMES.has(name);
      elements.push({name, blocksImageReference, startsForeignContent});
      if (blocksImageReference) blockedDepth += 1;
      if (startsForeignContent) foreignDepth += 1;
      if (name === "frameset") imageReferencesPermanentlyBlocked = true;
    }
    index = tagEnd + 1;
  }
  return found;
}
