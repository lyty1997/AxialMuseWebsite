import {ContentDecodeError} from "./frontmatter.mjs";

export {ContentDecodeError};

export const CONTENT_JSON_MAX_BYTES = 1024 * 1024;
export const CONTENT_JSON_MAX_DEPTH = 128;

const UNKNOWN_SOURCE_PATH = "site-content/unknown";
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const UTF8_DECODER = new TextDecoder("utf-8", {fatal: true});
const UTF8_ENCODER = new TextEncoder();
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
).get;

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

function fail(code, sourcePath, cause) {
  throw new ContentDecodeError(code, sourcePath, {cause});
}

function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function assertJsonLexicalStructure(text, sourcePath) {
  let index = 0;

  const skipWhitespace = () => {
    while (/^[\t\n\r ]$/u.test(text[index] ?? "")) index += 1;
  };
  const invalid = () => fail(
    "CONTENT_JSON_INVALID",
    sourcePath,
    new SyntaxError("JSON 文档语法无效。"),
  );

  const parseString = () => {
    if (text[index] !== "\"") invalid();
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      if (character === "\"") {
        try {
          return JSON.parse(text.slice(start, index));
        } catch (cause) {
          fail("CONTENT_JSON_INVALID", sourcePath, cause);
        }
      }
    }
    invalid();
  };

  const parseValue = (depth) => {
    if (depth > CONTENT_JSON_MAX_DEPTH) {
      fail(
        "CONTENT_JSON_DEPTH",
        sourcePath,
        new RangeError("JSON 文档嵌套过深。"),
      );
    }
    skipWhitespace();
    if (text[index] === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < text.length) {
        const key = parseString();
        if (keys.has(key)) {
          fail(
            "CONTENT_JSON_DUPLICATE_KEY",
            sourcePath,
            new SyntaxError("JSON object 含重复键。"),
          );
        }
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") invalid();
        index += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") invalid();
        index += 1;
        skipWhitespace();
      }
      invalid();
    }
    if (text[index] === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (index < text.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") invalid();
        index += 1;
      }
      invalid();
    }
    if (text[index] === "\"") {
      parseString();
      return;
    }
    const start = index;
    while (index < text.length && !/[\t\n\r ,\]}]/u.test(text[index])) index += 1;
    if (start === index) invalid();
    try {
      JSON.parse(text.slice(start, index));
    } catch (cause) {
      fail("CONTENT_JSON_INVALID", sourcePath, cause);
    }
  };

  parseValue(0);
  skipWhitespace();
  if (index !== text.length) invalid();
}

function readOptions(options) {
  let isObject;
  try {
    isObject = options !== null
      && typeof options === "object"
      && !Array.isArray(options);
  } catch (cause) {
    fail("CONTENT_JSON_INPUT", UNKNOWN_SOURCE_PATH, cause);
  }
  if (!isObject) {
    fail(
      "CONTENT_JSON_INPUT",
      UNKNOWN_SOURCE_PATH,
      new TypeError("JSON 解码选项必须是对象。"),
    );
  }
  try {
    return {bytes: options.bytes, sourcePath: options.sourcePath};
  } catch (cause) {
    fail("CONTENT_JSON_INPUT", UNKNOWN_SOURCE_PATH, cause);
  }
}

export function decodeJsonDocument(options) {
  const {bytes, sourcePath} = readOptions(options);
  let byteLength;
  let isValidInput;
  try {
    isValidInput = isSafeSourcePath(sourcePath)
      && ArrayBuffer.isView(bytes)
      && bytes instanceof Uint8Array;
    if (isValidInput) byteLength = TYPED_ARRAY_BYTE_LENGTH.call(bytes);
  } catch (cause) {
    fail(
      "CONTENT_JSON_INPUT",
      sourcePath,
      cause,
    );
  }
  if (!isValidInput) {
    fail(
      "CONTENT_JSON_INPUT",
      sourcePath,
      new TypeError("JSON 解码输入字段不合法。"),
    );
  }
  if (byteLength === 0 || byteLength > CONTENT_JSON_MAX_BYTES) {
    fail(
      "CONTENT_JSON_SIZE",
      sourcePath,
      new RangeError("JSON 文档字节数超出受控边界。"),
    );
  }

  let stableBytes;
  try {
    stableBytes = new Uint8Array(byteLength);
    Uint8Array.prototype.set.call(stableBytes, bytes);
  } catch (cause) {
    fail("CONTENT_JSON_INPUT", sourcePath, cause);
  }

  let text;
  try {
    text = UTF8_DECODER.decode(stableBytes);
  } catch (cause) {
    fail("CONTENT_JSON_UTF8", sourcePath, cause);
  }
  if (!sameBytes(stableBytes, UTF8_ENCODER.encode(text))) {
    fail(
      "CONTENT_JSON_UTF8",
      sourcePath,
      new TypeError("JSON 文档不是规范 UTF-8 字节序列。"),
    );
  }

  assertJsonLexicalStructure(text, sourcePath);
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    fail("CONTENT_JSON_INVALID", sourcePath, cause);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(
      "CONTENT_JSON_ROOT",
      sourcePath,
      new TypeError("JSON 文档根必须是 object。"),
    );
  }
  return value;
}
