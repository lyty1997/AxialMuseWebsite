import assert from "node:assert/strict";
import test from "node:test";
import {
  ContentDecodeError,
  decodeFrontMatter,
} from "../../scripts/content/frontmatter.mjs";
import {
  CONTENT_JSON_MAX_BYTES,
  CONTENT_JSON_MAX_DEPTH,
  decodeJsonDocument,
} from "../../scripts/content/json.mjs";

const ENCODER = new TextEncoder();

function bytes(text) {
  return ENCODER.encode(text);
}

function assertDecodeError(error, code, sourcePath) {
  assert.ok(error instanceof ContentDecodeError);
  assert.equal(error.code, code);
  assert.equal(error.sourcePath, sourcePath);
  assert.ok(error.cause instanceof Error);
  assert.equal(error.stack, undefined);
  assert.equal(error.cause.stack, undefined);
  return true;
}

function exposedErrorText(error) {
  return [
    String(error),
    String(error.cause),
    error.stack ?? "",
    error.cause?.stack ?? "",
    JSON.stringify(error),
  ].join("\n");
}

test("I-06 frontmatter 注入解析器只调用一次并返回唯一结构化结果", async () => {
  const calls = [];
  const fileContent = "---\ntitle: 示例\n---\n\n正文\n";
  const result = await decodeFrontMatter({
    fileContent,
    filePath: "/private/work/site-content/writing/example/index.mdx",
    sourcePath: "site-content/writing/example/index.mdx",
    parser(input) {
      calls.push(input);
      return {
        content: "\n正文\n",
        frontMatter: {
          metadata: {language: "zh-CN"},
          title: "示例",
        },
        ignored: "解析器私有字段",
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    fileContent,
    filePath: "/private/work/site-content/writing/example/index.mdx",
  });
  assert.deepEqual(result, {
    content: "\n正文\n",
    frontMatter: {
      metadata: {language: "zh-CN"},
      title: "示例",
    },
  });
  assert.deepEqual(Object.keys(result).sort(), ["content", "frontMatter"]);
});

test("I-06 frontmatter 解析器异常被稳定分类并完整脱敏", async () => {
  const secretInput = "不得进入错误边界的正文";
  const secretPath = "/private/work/secret/article.mdx";
  let calls = 0;
  let caught;
  try {
    await decodeFrontMatter({
      fileContent: secretInput,
      filePath: secretPath,
      sourcePath: "site-content/writing/example/index.mdx",
      parser() {
        calls += 1;
        throw new Error(`${secretPath}: ${secretInput}`);
      },
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(calls, 1);
  assertDecodeError(
    caught,
    "CONTENT_FRONTMATTER_PARSE",
    "site-content/writing/example/index.mdx",
  );
  const exposed = exposedErrorText(caught);
  assert.doesNotMatch(exposed, /不得进入错误边界的正文/u);
  assert.doesNotMatch(exposed, /\/private\/work/u);
});

test("I-06 frontmatter 非法 parser 与非法 shape 均失败关闭且不重试", async () => {
  const revokedShape = Proxy.revocable({}, {});
  revokedShape.revoke();
  const accessorFrontMatter = {};
  Object.defineProperty(accessorFrontMatter, "title", {
    enumerable: true,
    get() {
      throw new Error("ACCESSOR_SECRET_MUST_NOT_ESCAPE");
    },
  });
  const cyclicFrontMatter = {};
  cyclicFrontMatter.self = cyclicFrontMatter;
  await assert.rejects(
    decodeFrontMatter({
      fileContent: "正文",
      filePath: "/private/work/article.mdx",
      sourcePath: "site-content/writing/example/index.mdx",
      parser: null,
    }),
    (error) => assertDecodeError(
      error,
      "CONTENT_FRONTMATTER_PARSER",
      "site-content/writing/example/index.mdx",
    ),
  );

  const illegalResults = [
    null,
    [],
    new Map([["frontMatter", {}], ["content", "正文"]]),
    {content: "正文", frontMatter: revokedShape.proxy},
    {content: "正文"},
    {content: "正文", frontMatter: []},
    {content: "正文", frontMatter: new Map([["title", "hidden"]])},
    {content: "正文", frontMatter: new Date(0)},
    {content: "正文", frontMatter: accessorFrontMatter},
    {content: "正文", frontMatter: cyclicFrontMatter},
    {content: new Uint8Array(), frontMatter: {}},
  ];
  for (const illegalResult of illegalResults) {
    let calls = 0;
    await assert.rejects(
      decodeFrontMatter({
        fileContent: "正文",
        filePath: "/private/work/article.mdx",
        sourcePath: "site-content/writing/example/index.mdx",
        parser() {
          calls += 1;
          return illegalResult;
        },
      }),
      (error) => assertDecodeError(
        error,
        "CONTENT_FRONTMATTER_SHAPE",
        "site-content/writing/example/index.mdx",
      ),
    );
    assert.equal(calls, 1);
  }

  const secret = "SHAPE_SECRET_MUST_NOT_ESCAPE";
  let caught;
  try {
    await decodeFrontMatter({
      fileContent: "正文",
      filePath: "/private/work/article.mdx",
      sourcePath: "site-content/writing/example/index.mdx",
      parser() {
        return {
          content: "正文",
          frontMatter: new Proxy({}, {
            getPrototypeOf() {
              throw new Error(secret);
            },
          }),
        };
      },
    });
  } catch (error) {
    caught = error;
  }
  assertDecodeError(
    caught,
    "CONTENT_FRONTMATTER_SHAPE",
    "site-content/writing/example/index.mdx",
  );
  assert.doesNotMatch(exposedErrorText(caught), new RegExp(secret, "u"));
});

test("I-06 frontmatter 在领域消费前递归物化为无 getter 的冻结快照", async () => {
  let getterCalls = 0;
  const proxiedFrontMatter = new Proxy({
    classification: {topics: ["architecture"]},
    title: "安全快照",
  }, {
    get() {
      getterCalls += 1;
      throw new Error("PROXY_GET_SECRET_MUST_NOT_ESCAPE");
    },
  });
  const result = await decodeFrontMatter({
    fileContent: "正文",
    filePath: "/private/work/article.mdx",
    sourcePath: "site-content/writing/example/index.mdx",
    parser() {
      return {content: "正文", frontMatter: proxiedFrontMatter};
    },
  });

  assert.equal(getterCalls, 0);
  assert.deepEqual(result.frontMatter, {
    classification: {topics: ["architecture"]},
    title: "安全快照",
  });
  assert.ok(Object.isFrozen(result.frontMatter));
  assert.ok(Object.isFrozen(result.frontMatter.classification));
  assert.ok(Object.isFrozen(result.frontMatter.classification.topics));
  assert.equal(Object.getOwnPropertyDescriptor(result.frontMatter, "title").get, undefined);
});

test("I-06 revoked options proxy 被稳定归类为脱敏输入错误", async () => {
  const frontMatterOptions = Proxy.revocable({}, {});
  frontMatterOptions.revoke();
  await assert.rejects(
    decodeFrontMatter(frontMatterOptions.proxy),
    (error) => assertDecodeError(
      error,
      "CONTENT_FRONTMATTER_INPUT",
      "site-content/unknown",
    ),
  );

  const jsonOptions = Proxy.revocable({}, {});
  jsonOptions.revoke();
  assert.throws(
    () => decodeJsonDocument(jsonOptions.proxy),
    (error) => assertDecodeError(
      error,
      "CONTENT_JSON_INPUT",
      "site-content/unknown",
    ),
  );

  const thrownValue = Proxy.revocable({}, {});
  thrownValue.revoke();
  for (const [decode, code] of [
    [() => decodeFrontMatter(new Proxy({}, {
      get() {
        throw thrownValue.proxy;
      },
    })), "CONTENT_FRONTMATTER_INPUT"],
    [() => decodeJsonDocument(new Proxy({}, {
      get() {
        throw thrownValue.proxy;
      },
    })), "CONTENT_JSON_INPUT"],
  ]) {
    let caught;
    try {
      await decode();
    } catch (error) {
      caught = error;
    }
    assertDecodeError(caught, code, "site-content/unknown");
  }
});

test("I-06 绝对与 URI sourcePath 不进入 frontmatter/JSON 错误边界", async () => {
  const unsafePaths = [
    "/private/work/site-content/article.mdx",
    "C:/private/work/site-content/article.mdx",
    "file:private-work/article.mdx",
  ];
  for (const unsafePath of unsafePaths) {
    await assert.rejects(
      decodeFrontMatter({
        fileContent: "正文",
        filePath: unsafePath,
        sourcePath: unsafePath,
        parser() {
          throw new Error("不应调用");
        },
      }),
      (error) => assertDecodeError(
        error,
        "CONTENT_FRONTMATTER_INPUT",
        "site-content/unknown",
      ),
    );
    assert.throws(
      () => decodeJsonDocument({bytes: bytes("{}"), sourcePath: unsafePath}),
      (error) => assertDecodeError(
        error,
        "CONTENT_JSON_INPUT",
        "site-content/unknown",
      ),
    );
  }
});

test("I-06 JSON Uint8Array 正常与嵌套 object 解码", () => {
  const decoded = decodeJsonDocument({
    bytes: bytes(JSON.stringify({
      projects: [{id: "axial-muse", labels: {"zh-CN": "缪思"}}],
      version: 1,
    })),
    sourcePath: "site-content/registries/projects.json",
  });
  assert.deepEqual(decoded, {
    projects: [{id: "axial-muse", labels: {"zh-CN": "缪思"}}],
    version: 1,
  });
});

test("I-06 JSON 拒绝代理 typed array 且不泄露 trap 细节", () => {
  const secret = "JSON_PROXY_SECRET_MUST_NOT_ESCAPE";
  const spoofedDataView = new DataView(bytes("{}").buffer);
  Object.defineProperty(spoofedDataView, Symbol.toStringTag, {value: "Uint8Array"});
  spoofedDataView[0] = 0x7b;
  spoofedDataView[1] = 0x7d;
  const hostileInputs = [
    new Proxy(bytes("{}"), {}),
    spoofedDataView,
    new Proxy({}, {
      getPrototypeOf() {
        throw new Error(secret);
      },
    }),
  ];
  for (const input of hostileInputs) {
    let caught;
    try {
      decodeJsonDocument({
        bytes: input,
        sourcePath: "site-content/registries/projects.json",
      });
    } catch (error) {
      caught = error;
    }
    assertDecodeError(
      caught,
      "CONTENT_JSON_INPUT",
      "site-content/registries/projects.json",
    );
    assert.doesNotMatch(exposedErrorText(caught), new RegExp(secret, "u"));
  }
});

test("I-06 JSON 只信任 typed-array 内部长度并复制稳定字节快照", () => {
  const oversized = new Uint8Array(CONTENT_JSON_MAX_BYTES + 1);
  Object.defineProperty(oversized, "byteLength", {
    get() {
      return 2;
    },
  });
  assert.throws(
    () => decodeJsonDocument({
      bytes: oversized,
      sourcePath: "site-content/registries/projects.json",
    }),
    (error) => assertDecodeError(
      error,
      "CONTENT_JSON_SIZE",
      "site-content/registries/projects.json",
    ),
  );

  const shadowed = bytes("{}");
  Object.defineProperty(shadowed, "byteLength", {
    get() {
      throw new Error("SHADOWED_LENGTH_MUST_NOT_RUN");
    },
  });
  assert.deepEqual(decodeJsonDocument({
    bytes: shadowed,
    sourcePath: "site-content/registries/projects.json",
  }), {});
});

test("I-06 JSON 在 JSON.parse 前拒绝任意层级与转义等价重复键", () => {
  for (const source of [
    "{\"id\":1,\"id\":2}",
    "{\"nested\":{\"id\":1,\"\\u0069d\":2}}",
  ]) {
    assert.throws(
      () => decodeJsonDocument({
        bytes: bytes(source),
        sourcePath: "site-content/registries/projects.json",
      }),
      (error) => assertDecodeError(
        error,
        "CONTENT_JSON_DUPLICATE_KEY",
        "site-content/registries/projects.json",
      ),
    );
  }
});

test("I-06 JSON 拒绝非法 UTF-8 与 BOM 文本形态", () => {
  for (const input of [
    new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]),
    new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("{}")]),
  ]) {
    assert.throws(
      () => decodeJsonDocument({
        bytes: input,
        sourcePath: "site-content/registries/projects.json",
      }),
      (error) => assertDecodeError(
        error,
        "CONTENT_JSON_UTF8",
        "site-content/registries/projects.json",
      ),
    );
  }
});

test("I-06 JSON 大小与深度边界失败关闭", () => {
  const prefix = "{\"padding\":\"";
  const suffix = "\"}";
  const exactLimit = bytes(
    `${prefix}${"a".repeat(CONTENT_JSON_MAX_BYTES - prefix.length - suffix.length)}${suffix}`,
  );
  assert.equal(exactLimit.byteLength, CONTENT_JSON_MAX_BYTES);
  assert.equal(
    decodeJsonDocument({
      bytes: exactLimit,
      sourcePath: "site-content/registries/projects.json",
    }).padding.length,
    CONTENT_JSON_MAX_BYTES - prefix.length - suffix.length,
  );
  assert.throws(
    () => decodeJsonDocument({
      bytes: new Uint8Array(CONTENT_JSON_MAX_BYTES + 1),
      sourcePath: "site-content/registries/projects.json",
    }),
    (error) => assertDecodeError(
      error,
      "CONTENT_JSON_SIZE",
      "site-content/registries/projects.json",
    ),
  );

  let acceptedNested = "0";
  for (let depth = 1; depth < CONTENT_JSON_MAX_DEPTH; depth += 1) {
    acceptedNested = `[${acceptedNested}]`;
  }
  assert.ok(Array.isArray(decodeJsonDocument({
    bytes: bytes(`{\"nested\":${acceptedNested}}`),
    sourcePath: "site-content/registries/projects.json",
  }).nested));

  const rejectedNested = `[${acceptedNested}]`;
  assert.throws(
    () => decodeJsonDocument({
      bytes: bytes(`{\"nested\":${rejectedNested}}`),
      sourcePath: "site-content/registries/projects.json",
    }),
    (error) => assertDecodeError(
      error,
      "CONTENT_JSON_DEPTH",
      "site-content/registries/projects.json",
    ),
  );
});

test("I-06 JSON 拒绝非法语法、非 object 根与非字节输入", () => {
  const cases = [
    [bytes("{\"id\":}"), "CONTENT_JSON_INVALID"],
    [bytes("[]"), "CONTENT_JSON_ROOT"],
    [bytes("null"), "CONTENT_JSON_ROOT"],
    ["{}", "CONTENT_JSON_INPUT"],
  ];
  for (const [input, code] of cases) {
    assert.throws(
      () => decodeJsonDocument({
        bytes: input,
        sourcePath: "site-content/registries/projects.json",
      }),
      (error) => assertDecodeError(
        error,
        code,
        "site-content/registries/projects.json",
      ),
    );
  }
});
