const UNKNOWN_SOURCE_PATH = "site-content/unknown";
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const STRUCTURED_DATA_MAX_DEPTH = 128;

const ERROR_MESSAGES = Object.freeze({
  CONTENT_FRONTMATTER_INPUT: "frontmatter 解码输入不合法。",
  CONTENT_FRONTMATTER_DEPENDENCY: "冻结的 frontmatter 解析器不可用。",
  CONTENT_FRONTMATTER_PARSER: "注入的 frontmatter 解析器不合法。",
  CONTENT_FRONTMATTER_PARSE: "frontmatter 结构化解析失败。",
  CONTENT_FRONTMATTER_SHAPE: "frontmatter 解析结果结构不合法。",
  CONTENT_JSON_INPUT: "JSON 解码输入不合法。",
  CONTENT_JSON_SIZE: "JSON 文档字节数超出受控边界。",
  CONTENT_JSON_UTF8: "JSON 文档不是合法的规范 UTF-8。",
  CONTENT_JSON_INVALID: "JSON 文档语法不合法。",
  CONTENT_JSON_DEPTH: "JSON 文档嵌套深度超出受控边界。",
  CONTENT_JSON_DUPLICATE_KEY: "JSON 文档含重复 object key。",
  CONTENT_JSON_ROOT: "JSON 文档根必须是 object。",
});

function isSafeSourcePath(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 4096
    || value.startsWith("/")
    || URL_SCHEME_PATTERN.test(value)
    || value.includes("\\")
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => (
    segment.length > 0
    && segment !== "."
    && segment !== ".."
  ));
}

function isPlainRecord(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function snapshotStructuredData(value, depth = 0, active = new Set()) {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (depth > STRUCTURED_DATA_MAX_DEPTH || typeof value !== "object") {
    throw new TypeError("frontmatter 含不受支持的结构化值。");
  }

  let isArray;
  let prototype;
  let descriptors;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (cause) {
    throw new TypeError("frontmatter 结构化快照失败。", {cause});
  }
  if (
    (isArray && prototype !== Array.prototype)
    || (!isArray && prototype !== Object.prototype && prototype !== null)
    || active.has(value)
  ) {
    throw new TypeError("frontmatter 含非 plain object 或循环引用。");
  }

  active.add(value);
  try {
    if (isArray) {
      const lengthDescriptor = descriptors.length;
      const length = lengthDescriptor?.value;
      const keys = Reflect.ownKeys(descriptors).filter((key) => key !== "length");
      if (
        !Number.isSafeInteger(length)
        || length < 0
        || keys.length !== length
        || keys.some((key) => (
          typeof key !== "string"
          || !/^(?:0|[1-9]\d*)$/u.test(key)
          || Number(key) >= length
        ))
      ) {
        throw new TypeError("frontmatter array 必须是稠密的普通数组。");
      }
      const snapshot = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined
          || !Object.hasOwn(descriptor, "value")
          || !descriptor.enumerable
        ) {
          throw new TypeError("frontmatter array 元素必须是可枚举数据属性。");
        }
        snapshot.push(snapshotStructuredData(descriptor.value, depth + 1, active));
      }
      return Object.freeze(snapshot);
    }

    const snapshot = Object.create(prototype);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (
        typeof key !== "string"
        || !Object.hasOwn(descriptor, "value")
        || !descriptor.enumerable
      ) {
        throw new TypeError("frontmatter object 字段必须是可枚举字符串数据属性。");
      }
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        value: snapshotStructuredData(descriptor.value, depth + 1, active),
        writable: false,
      });
    }
    return Object.freeze(snapshot);
  } finally {
    active.delete(value);
  }
}

function sanitizedCause() {
  const cause = new Error("底层内容解码失败；原始异常细节已抑制。");
  cause.name = "ContentDecodeCause";
  Object.defineProperty(cause, "stack", {
    configurable: true,
    value: undefined,
    writable: false,
  });
  return cause;
}

export class ContentDecodeError extends Error {
  constructor(code, sourcePath, options = {}) {
    const safeSourcePath = isSafeSourcePath(sourcePath)
      ? sourcePath
      : UNKNOWN_SOURCE_PATH;
    super(ERROR_MESSAGES[code] ?? "内容解码失败。", {
      cause: options.cause === undefined ? undefined : sanitizedCause(),
    });
    this.name = "ContentDecodeError";
    this.code = code;
    this.sourcePath = safeSourcePath;
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: undefined,
      writable: false,
    });
  }
}

function fail(code, sourcePath, cause) {
  throw new ContentDecodeError(code, sourcePath, {cause});
}

function readOptions(options) {
  let isObject;
  try {
    isObject = options !== null
      && typeof options === "object"
      && !Array.isArray(options);
  } catch (cause) {
    fail("CONTENT_FRONTMATTER_INPUT", UNKNOWN_SOURCE_PATH, cause);
  }
  if (!isObject) {
    fail(
      "CONTENT_FRONTMATTER_INPUT",
      UNKNOWN_SOURCE_PATH,
      new TypeError("frontmatter 选项必须是对象。"),
    );
  }
  try {
    return {
      fileContent: options.fileContent,
      filePath: options.filePath,
      parser: options.parser,
      sourcePath: options.sourcePath,
    };
  } catch (cause) {
    fail("CONTENT_FRONTMATTER_INPUT", UNKNOWN_SOURCE_PATH, cause);
  }
}

async function resolveParser(parser, sourcePath) {
  if (parser !== undefined) {
    if (typeof parser !== "function") {
      fail(
        "CONTENT_FRONTMATTER_PARSER",
        sourcePath,
        new TypeError("注入解析器必须是函数。"),
      );
    }
    return parser;
  }

  let parserModule;
  try {
    parserModule = await import("@docusaurus/utils");
  } catch (cause) {
    fail("CONTENT_FRONTMATTER_DEPENDENCY", sourcePath, cause);
  }
  if (typeof parserModule.DEFAULT_PARSE_FRONT_MATTER !== "function") {
    fail(
      "CONTENT_FRONTMATTER_DEPENDENCY",
      sourcePath,
      new TypeError("冻结依赖缺少默认 frontmatter 解析器。"),
    );
  }
  return parserModule.DEFAULT_PARSE_FRONT_MATTER;
}

export async function decodeFrontMatter(options) {
  const {
    fileContent,
    filePath,
    parser: injectedParser,
    sourcePath,
  } = readOptions(options);
  if (
    !isSafeSourcePath(sourcePath)
    || typeof filePath !== "string"
    || filePath.length === 0
    || filePath.includes("\0")
    || typeof fileContent !== "string"
  ) {
    fail(
      "CONTENT_FRONTMATTER_INPUT",
      sourcePath,
      new TypeError("frontmatter 输入字段不合法。"),
    );
  }

  const parser = await resolveParser(injectedParser, sourcePath);
  let parsed;
  try {
    parsed = await parser({fileContent, filePath});
  } catch (cause) {
    fail("CONTENT_FRONTMATTER_PARSE", sourcePath, cause);
  }

  let frontMatter;
  let content;
  try {
    frontMatter = parsed?.frontMatter;
    content = parsed?.content;
  } catch (cause) {
    fail("CONTENT_FRONTMATTER_SHAPE", sourcePath, cause);
  }
  if (
    !isPlainRecord(parsed)
    || !isPlainRecord(frontMatter)
    || typeof content !== "string"
  ) {
    fail(
      "CONTENT_FRONTMATTER_SHAPE",
      sourcePath,
      new TypeError("frontmatter 解析结果缺少受控字段。"),
    );
  }

  let stableFrontMatter;
  try {
    stableFrontMatter = snapshotStructuredData(frontMatter);
  } catch (cause) {
    fail("CONTENT_FRONTMATTER_SHAPE", sourcePath, cause);
  }

  return Object.freeze({frontMatter: stableFrontMatter, content});
}
