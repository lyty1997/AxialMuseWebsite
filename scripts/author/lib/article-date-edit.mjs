const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RELATED_FIELD_PATTERN =
  /^(?:(?:publicationStatus|publishedAt|updatedAt)\s*:|["'](?:publicationStatus|publishedAt|updatedAt)["']\s*:|\?\s*(?:publicationStatus|publishedAt|updatedAt)\s*$)/u;
const STATUS_LINE_PATTERN = /^publicationStatus: "([^"\\]*)"$/u;
const DATE_LINE_PATTERN = /^(publishedAt|updatedAt): "([^"\\]*)"$/u;
const ERROR_MESSAGES = Object.freeze({
  AUTHOR_DATE_SOURCE: "文章日期源无法安全定点编辑。",
  AUTHOR_DATE_STATE: "文章状态不允许执行该日期操作。",
  AUTHOR_DATE_CLOCK: "文章日期时钟无法产生合法的上海日期。",
});
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", {fatal: true});
const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat(
  "en-CA-u-ca-iso8601-nu-latn",
  {
    calendar: "iso8601",
    day: "2-digit",
    month: "2-digit",
    numberingSystem: "latn",
    timeZone: "Asia/Shanghai",
    year: "numeric",
  },
);

function fail(code) {
  throw new ArticleDateEditError(code);
}

function isPlainRecord(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isDate(value) {
  if (typeof value !== "string") return false;
  const match = DATE_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1
    && month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth(year, month);
}

function isCanonicalUtf8String(value) {
  if (typeof value !== "string") return false;
  try {
    return UTF8_DECODER.decode(UTF8_ENCODER.encode(value)) === value;
  } catch {
    return false;
  }
}

function readDecoded(decoded) {
  if (
    !isPlainRecord(decoded)
    || !isPlainRecord(decoded.frontMatter)
    || typeof decoded.content !== "string"
  ) {
    fail("AUTHOR_DATE_SOURCE");
  }
  return decoded.frontMatter;
}

function inspectFrontMatter(fileContent) {
  if (
    !isCanonicalUtf8String(fileContent)
    || fileContent.startsWith("\uFEFF")
    || fileContent.includes("\r")
    || fileContent.includes("\0")
    || !fileContent.startsWith("---\n")
  ) {
    fail("AUTHOR_DATE_SOURCE");
  }
  const closingStart = fileContent.indexOf("\n---\n", 4);
  if (closingStart < 4) fail("AUTHOR_DATE_SOURCE");

  const fields = new Map();
  const frontMatterText = fileContent.slice(4, closingStart);
  let lineStart = 4;
  for (const line of frontMatterText.split("\n")) {
    const lineEnd = lineStart + line.length;
    let field;
    let value;
    const status = STATUS_LINE_PATTERN.exec(line);
    const date = DATE_LINE_PATTERN.exec(line);
    if (status !== null) {
      field = "publicationStatus";
      value = status[1];
    } else if (date !== null) {
      field = date[1];
      value = date[2];
    } else if (RELATED_FIELD_PATTERN.test(line)) {
      fail("AUTHOR_DATE_SOURCE");
    }

    if (field !== undefined) {
      if (fields.has(field)) fail("AUTHOR_DATE_SOURCE");
      const valueStart = line.indexOf('"') + 1;
      fields.set(field, Object.freeze({
        lineEnd,
        lineStart,
        value,
        valueEnd: lineStart + line.lastIndexOf('"'),
        valueStart: lineStart + valueStart,
      }));
    }
    lineStart = lineEnd + 1;
  }
  return Object.freeze({closingStart, fields});
}

function assertDecodedField(frontMatter, field, layoutField) {
  const hasDecoded = Object.hasOwn(frontMatter, field);
  if ((layoutField === undefined) !== !hasDecoded) {
    fail("AUTHOR_DATE_SOURCE");
  }
  if (layoutField !== undefined && frontMatter[field] !== layoutField.value) {
    fail("AUTHOR_DATE_SOURCE");
  }
}

function inspectSource(decoded, fileContent) {
  const frontMatter = readDecoded(decoded);
  if (
    typeof frontMatter.articleId !== "string"
    || !UUID_V7_PATTERN.test(frontMatter.articleId)
  ) {
    fail("AUTHOR_DATE_SOURCE");
  }
  const layout = inspectFrontMatter(fileContent);
  const status = layout.fields.get("publicationStatus");
  const publishedAt = layout.fields.get("publishedAt");
  const updatedAt = layout.fields.get("updatedAt");
  if (status === undefined) fail("AUTHOR_DATE_SOURCE");
  assertDecodedField(frontMatter, "publicationStatus", status);
  assertDecodedField(frontMatter, "publishedAt", publishedAt);
  assertDecodedField(frontMatter, "updatedAt", updatedAt);
  return Object.freeze({
    articleId: frontMatter.articleId,
    frontMatter,
    layout,
    publishedAt,
    status,
    updatedAt,
  });
}

function planPublish(source, fileContent, today) {
  if (
    source.frontMatter.publicationStatus !== "published"
    || Object.hasOwn(source.frontMatter, "publishedAt")
    || Object.hasOwn(source.frontMatter, "updatedAt")
  ) {
    fail("AUTHOR_DATE_STATE");
  }
  if (!isDate(today)) fail("AUTHOR_DATE_CLOCK");

  const insertion = `\npublishedAt: "${today}"\nupdatedAt: "${today}"`;
  const offset = source.status.lineEnd;
  return Object.freeze({
    articleId: source.articleId,
    changed: true,
    fileContent: `${fileContent.slice(0, offset)}${insertion}${fileContent.slice(offset)}`,
    publishedAt: today,
    updatedAt: today,
  });
}

function planRevise(source, fileContent, today) {
  if (
    source.frontMatter.publicationStatus !== "published"
    || source.publishedAt === undefined
    || source.updatedAt === undefined
    || !isDate(source.frontMatter.publishedAt)
    || !isDate(source.frontMatter.updatedAt)
    || source.frontMatter.updatedAt < source.frontMatter.publishedAt
  ) {
    fail("AUTHOR_DATE_STATE");
  }
  if (!isDate(today)) fail("AUTHOR_DATE_CLOCK");
  if (
    today < source.frontMatter.publishedAt
    || today < source.frontMatter.updatedAt
  ) {
    fail("AUTHOR_DATE_CLOCK");
  }
  if (today === source.frontMatter.updatedAt) {
    return Object.freeze({
      articleId: source.articleId,
      changed: false,
      fileContent,
      publishedAt: source.frontMatter.publishedAt,
      updatedAt: source.frontMatter.updatedAt,
    });
  }

  return Object.freeze({
    articleId: source.articleId,
    changed: true,
    fileContent: `${
      fileContent.slice(0, source.updatedAt.valueStart)
    }${today}${fileContent.slice(source.updatedAt.valueEnd)}`,
    publishedAt: source.frontMatter.publishedAt,
    updatedAt: today,
  });
}

export class ArticleDateEditError extends Error {
  constructor(code) {
    const stableCode = Object.hasOwn(ERROR_MESSAGES, code)
      ? code
      : "AUTHOR_DATE_SOURCE";
    super(ERROR_MESSAGES[stableCode]);
    this.name = "ArticleDateEditError";
    this.code = stableCode;
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: undefined,
      writable: false,
    });
  }
}

export function formatShanghaiDate(epochMilliseconds) {
  if (
    typeof epochMilliseconds !== "number"
    || !Number.isFinite(epochMilliseconds)
    || !Number.isInteger(epochMilliseconds)
  ) {
    fail("AUTHOR_DATE_CLOCK");
  }

  try {
    const instant = new Date(epochMilliseconds);
    if (instant.getTime() !== epochMilliseconds) fail("AUTHOR_DATE_CLOCK");
    const values = new Map();
    for (const part of SHANGHAI_DATE_FORMATTER.formatToParts(instant)) {
      if (part.type === "year" || part.type === "month" || part.type === "day") {
        if (values.has(part.type)) fail("AUTHOR_DATE_CLOCK");
        values.set(part.type, part.value);
      }
    }
    const value = `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
    if (!isDate(value)) fail("AUTHOR_DATE_CLOCK");
    return value;
  } catch (error) {
    if (
      error instanceof ArticleDateEditError
      && error.code === "AUTHOR_DATE_CLOCK"
    ) {
      throw error;
    }
    fail("AUTHOR_DATE_CLOCK");
  }
}

export function planArticleDateEdit({
  action,
  decoded,
  fileContent,
  today,
} = {}) {
  if (action !== "publish" && action !== "revise") {
    fail("AUTHOR_DATE_STATE");
  }
  const source = inspectSource(decoded, fileContent);
  return action === "publish"
    ? planPublish(source, fileContent, today)
    : planRevise(source, fileContent, today);
}
