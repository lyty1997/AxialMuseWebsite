import { fail } from "./errors.mjs";

export function assertNoDuplicateJsonKeys(text, {
  duplicateCode,
  invalidCode,
  depthCode = invalidCode,
  label = "JSON",
  maxDepth = 128,
} = {}) {
  if (
    typeof text !== "string"
    || text.length === 0
    || typeof duplicateCode !== "string"
    || typeof invalidCode !== "string"
    || !Number.isSafeInteger(maxDepth)
    || maxDepth < 1
  ) {
    fail(invalidCode ?? "STRICT_JSON_INPUT", `${label} duplicate-key scanner 输入不合法。`);
  }
  let index = 0;

  const skipWhitespace = () => {
    while (/^[\t\n\r ]$/u.test(text[index] ?? "")) index += 1;
  };
  const invalid = () => fail(invalidCode, `${label} 不是合法 JSON。`);

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
        } catch {
          invalid();
        }
      }
    }
    invalid();
  };

  const parseValue = (depth) => {
    if (depth > maxDepth) {
      fail(depthCode, `${label} 嵌套深度超过受控上限。`);
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
          fail(duplicateCode, `${label} object key ${JSON.stringify(key)} 重复。`);
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
    } catch {
      invalid();
    }
  };

  parseValue(0);
  skipWhitespace();
  if (index !== text.length) invalid();
}
