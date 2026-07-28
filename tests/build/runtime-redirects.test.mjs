import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import fs, {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {EventEmitter} from "node:events";
import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import test from "node:test";
import {
  assertAcceptanceHttpResponse,
  assertPinnedNginxContainerArguments,
  buildNginxAcceptanceRequestCases,
  buildNginxServiceCreateArguments,
  extractInternalServiceEndpoint,
  NGINX_ACCEPTANCE_HTTP_ASSERTION_COUNT,
  NGINX_ACCEPTANCE_IMAGE,
  NGINX_ACCEPTANCE_PLATFORM,
  NGINX_ACCEPTANCE_VERSION,
  NginxDockerAcceptanceError,
  parseBusyBoxWgetResponse,
  renderNginxAcceptanceConfiguration,
  runNginxDockerAcceptance,
} from "../../scripts/release/lib/nginx-docker-acceptance.mjs";
import {
  CANONICAL_ORIGIN,
  collectPublicHtmlRoutes,
  compileRuntimeRedirectArtifacts,
  deriveRuntimeRedirectArtifacts,
  formatRuntimeRedirectError,
  parseRedirectRegistry,
  publicRouteFromHtmlPath,
  readRedirectRegistry,
  readRedirectRegistryFromRepositoryRoot,
  RuntimeRedirectError,
} from "../../scripts/release/lib/runtime-redirects.mjs";

const ENCODER = new TextEncoder();

function bytes(value) {
  return ENCODER.encode(value);
}

function registryDocument(redirects = [], overrides = {}) {
  return {
    version: "0.1.0",
    kind: "axial_muse_redirects",
    status: "active",
    owner: "AxialMuseWebsite",
    redirects,
    ...overrides,
  };
}

function parseRegistry(redirects = [], overrides = {}) {
  return parseRedirectRegistry(
    bytes(`${JSON.stringify(registryDocument(redirects, overrides), null, 2)}\n`),
  );
}

function hasCode(code) {
  return (error) => error instanceof RuntimeRedirectError && error.code === code;
}

function writeFixture(root, relativePath, contents = "") {
  const path = resolve(root, relativePath);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, contents, "utf8");
}

function withBuildFixture(files, action) {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-runtime-redirects-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      writeFixture(root, path, contents);
    }
    return action(root);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

function withFileSystemOverrides(overrides, action) {
  const originals = {
    closeSync: fs.closeSync,
    readFileSync: fs.readFileSync,
  };
  try {
    Object.assign(fs, overrides);
    syncBuiltinESMExports();
    return action();
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
}

test("E-014 当前空 registry 通过严格封套解析并保持深层只读", () => {
  const registry = readRedirectRegistry();
  assert.deepEqual(registry, registryDocument());
  assert.ok(Object.isFrozen(registry));
  assert.ok(Object.isFrozen(registry.redirects));
});

test("E-014 根与规范子目录 index.html 形成唯一公开路由，保留文件和资源不参与", () => {
  withBuildFixture({
    "index.html": "<!doctype html>",
    "projects/index.html": "<!doctype html>",
    "writing/example/index.html": "<!doctype html>",
    "404.html": "<!doctype html>",
    "assets/app.js": "export {};\n",
    "robots.txt": "User-agent: *\n",
    "sitemap.xml": "<urlset />\n",
  }, (root) => {
    assert.deepEqual(collectPublicHtmlRoutes(root), [
      "/",
      "/projects/",
      "/writing/example/",
    ]);
  });
  assert.equal(publicRouteFromHtmlPath("index.html"), "/");
  assert.equal(publicRouteFromHtmlPath("404.html"), undefined);
  assert.equal(
    publicRouteFromHtmlPath("writing/example/index.html"),
    "/writing/example/",
  );
});

test("E-014 合法登记生成双 registered alias、活动页 canonical-slash 与精确 golden 字节", () => {
  const reason = "审核说明\nmap $host; if (danger) { return 302; }";
  const artifacts = compileRuntimeRedirectArtifacts({
    publicRoutes: ["/projects/", "/new/", "/"],
    registry: parseRegistry([{from: "/old/", to: "/new/", reason}]),
    canonicalOrigin: CANONICAL_ORIGIN,
  });

  assert.deepEqual(artifacts.rules, [
    {kind: "canonical-slash", from: "/new", to: "/new/"},
    {kind: "registered", from: "/old", to: "/new/"},
    {kind: "registered", from: "/old/", to: "/new/"},
    {kind: "canonical-slash", from: "/projects", to: "/projects/"},
  ]);
  assert.equal(artifacts.registeredRuleCount, 2);
  assert.equal(artifacts.canonicalSlashRuleCount, 2);
  assert.equal(
    artifacts.runtimeRedirectsJson,
    `{
  "schemaVersion": "1.0.0",
  "canonicalOrigin": "https://www.axialmuse.com",
  "rules": [
    {
      "kind": "canonical-slash",
      "from": "/new",
      "to": "/new/"
    },
    {
      "kind": "registered",
      "from": "/old",
      "to": "/new/"
    },
    {
      "kind": "registered",
      "from": "/old/",
      "to": "/new/"
    },
    {
      "kind": "canonical-slash",
      "from": "/projects",
      "to": "/projects/"
    }
  ]
}
`,
  );
  assert.equal(
    artifacts.nginxRedirectsConfig,
    `location = /new {
  return 301 https://www.axialmuse.com/new/$is_args$args;
}
location = /old {
  return 301 https://www.axialmuse.com/new/$is_args$args;
}
location = /old/ {
  return 301 https://www.axialmuse.com/new/$is_args$args;
}
location = /projects {
  return 301 https://www.axialmuse.com/projects/$is_args$args;
}
`,
  );
  for (const forbidden of [reason, "map $host", "if (danger)", "return 302", "$host"]) {
    assert.equal(artifacts.runtimeRedirectsJson.includes(forbidden), false);
    assert.equal(artifacts.nginxRedirectsConfig.includes(forbidden), false);
  }
  assert.equal(
    artifacts.nginxRedirectsConfig
      .split("\n")
      .filter((line) => line.startsWith("location = "))
      .length,
    artifacts.rules.length,
  );
});

test("E-014 reason 与输入排列不影响两份派生字节", () => {
  const first = compileRuntimeRedirectArtifacts({
    publicRoutes: ["/", "/alpha/", "/omega/"],
    registry: parseRegistry([
      {from: "/legacy-z/", to: "/omega/", reason: "旧说明 Z"},
      {from: "/legacy-a/", to: "/alpha/", reason: "旧说明 A"},
    ]),
    canonicalOrigin: CANONICAL_ORIGIN,
  });
  const second = compileRuntimeRedirectArtifacts({
    publicRoutes: ["/omega/", "/", "/alpha/"],
    registry: parseRegistry([
      {from: "/legacy-a/", to: "/alpha/", reason: "已修改但不进入运行产物"},
      {from: "/legacy-z/", to: "/omega/", reason: "另一条审核说明"},
    ]),
    canonicalOrigin: CANONICAL_ORIGIN,
  });
  assert.equal(first.runtimeRedirectsJson, second.runtimeRedirectsJson);
  assert.equal(first.nginxRedirectsConfig, second.nginxRedirectsConfig);
});

test("E-014 strict parser 拒绝重复 JSON key、未知封套/条目字段与空 reason", () => {
  assert.throws(
    () => parseRedirectRegistry(bytes(
      '{"version":"0.1.0","version":"0.1.0","kind":"axial_muse_redirects","status":"active","owner":"AxialMuseWebsite","redirects":[]}',
    )),
    hasCode("RELEASE_REDIRECT_REGISTRY_JSON"),
  );
  assert.throws(
    () => parseRegistry([], {unexpected: true}),
    hasCode("RELEASE_REDIRECT_REGISTRY_SCHEMA"),
  );
  assert.throws(
    () => parseRegistry([{
      from: "/old/",
      to: "/new/",
      reason: "审核说明",
      unexpected: true,
    }]),
    hasCode("RELEASE_REDIRECT_REGISTRY_ENTRY"),
  );
  assert.throws(
    () => parseRegistry([{from: "/old/", to: "/new/", reason: " \n "}]),
    hasCode("RELEASE_REDIRECT_REGISTRY_ENTRY"),
  );
});

test("CODE-019 compile 只接受严格 parser 产出的冻结 registry", () => {
  let getterCalls = 0;
  const hostileRegistry = registryDocument([{
    get from() {
      getterCalls += 1;
      return getterCalls < 5
        ? "/old/"
        : "/old/ {\n  return 302 https://attacker.invalid;\n}\nlocation = /pwned/";
    },
    to: "/new/",
    reason: "审核说明",
  }]);
  assert.throws(
    () => compileRuntimeRedirectArtifacts({
      publicRoutes: ["/", "/new/"],
      registry: hostileRegistry,
      canonicalOrigin: CANONICAL_ORIGIN,
    }),
    hasCode("RELEASE_REDIRECT_REGISTRY_SCHEMA"),
  );
  assert.equal(getterCalls, 0);
});

test("CODE-019 固定 registry 安全读取拒绝叶子/祖先符号链接和硬链接", () => {
  withBuildFixture({}, (root) => {
    const registryBytes = `${JSON.stringify(registryDocument(), null, 2)}\n`;
    writeFixture(root, "outside.json", registryBytes);
    const registryPath = resolve(root, "docs/contracts/redirects.json");
    mkdirSync(dirname(registryPath), {recursive: true});
    symlinkSync(resolve(root, "outside.json"), registryPath);
    assert.throws(
      () => readRedirectRegistryFromRepositoryRoot(root),
      hasCode("RELEASE_REDIRECT_REGISTRY_READ"),
    );
    rmSync(registryPath);
    linkSync(resolve(root, "outside.json"), registryPath);
    assert.throws(
      () => readRedirectRegistryFromRepositoryRoot(root),
      hasCode("RELEASE_REDIRECT_REGISTRY_READ"),
    );
  });
  for (const ancestor of ["docs", "docs/contracts"]) {
    withBuildFixture({}, (root) => {
      const registryBytes = `${JSON.stringify(registryDocument(), null, 2)}\n`;
      if (ancestor === "docs") {
        writeFixture(
          root,
          "alternate-docs/contracts/redirects.json",
          registryBytes,
        );
        symlinkSync(resolve(root, "alternate-docs"), resolve(root, "docs"), "dir");
      } else {
        writeFixture(
          root,
          "alternate-contracts/redirects.json",
          registryBytes,
        );
        mkdirSync(resolve(root, "docs"), {recursive: true});
        symlinkSync(
          resolve(root, "alternate-contracts"),
          resolve(root, "docs/contracts"),
          "dir",
        );
      }
      assert.throws(
        () => readRedirectRegistryFromRepositoryRoot(root),
        hasCode("RELEASE_REDIRECT_REGISTRY_READ"),
        ancestor,
      );
    });
  }
});

test("CODE-003 registry 稳定读取保留 close-only 与 operation-first 双故障 cause", () => {
  withBuildFixture({}, (root) => {
    writeFixture(
      root,
      "docs/contracts/redirects.json",
      `${JSON.stringify(registryDocument(), null, 2)}\n`,
    );
    const originalCloseSync = fs.closeSync;
    const originalReadFileSync = fs.readFileSync;
    const closeOnly = new Error("close-only");
    let caught;
    withFileSystemOverrides({
      closeSync(descriptor) {
        originalCloseSync(descriptor);
        throw closeOnly;
      },
    }, () => {
      try {
        readRedirectRegistryFromRepositoryRoot(root);
      } catch (error) {
        caught = error;
      }
    });
    assert.ok(caught instanceof RuntimeRedirectError);
    assert.equal(caught.code, "RELEASE_REDIRECT_REGISTRY_READ");
    assert.strictEqual(caught.cause, closeOnly);

    const operation = new Error("operation");
    const close = new Error("close");
    caught = undefined;
    withFileSystemOverrides({
      readFileSync(path, ...args) {
        if (typeof path === "number") throw operation;
        return originalReadFileSync(path, ...args);
      },
      closeSync(descriptor) {
        originalCloseSync(descriptor);
        throw close;
      },
    }, () => {
      try {
        readRedirectRegistryFromRepositoryRoot(root);
      } catch (error) {
        caught = error;
      }
    });
    assert.ok(caught instanceof RuntimeRedirectError);
    assert.equal(caught.code, "RELEASE_REDIRECT_REGISTRY_READ");
    assert.ok(caught.cause instanceof AggregateError);
    assert.deepEqual(caught.cause.errors, [operation, close]);
  });
});

test("E-014 路径正向 allowlist 拒绝 origin、query、fragment、编码、点段与配置字符", () => {
  const invalidPaths = [
    "https://www.axialmuse.com/old/",
    "/old/?query=1",
    "/old/#fragment",
    "/old/%2fescape/",
    String.raw`/old\escape/`,
    "/old//escape/",
    "/old/../escape/",
    "/Old/",
    "/old_name/",
    "/old*/",
    "/old;/",
    "/old$/",
    "/old{/",
    "/old}/",
    "/old path/",
    "/old\u000a/",
  ];
  for (const from of invalidPaths) {
    assert.throws(
      () => parseRegistry([{from, to: "/new/", reason: "审核说明"}]),
      hasCode("RELEASE_REDIRECT_PATH"),
      from,
    );
  }
  for (const from of ["/assets/legacy/", "/img/legacy/", "/.well-known/legacy/"]) {
    assert.throws(
      () => parseRegistry([{from, to: "/new/", reason: "审核说明"}]),
      hasCode("RELEASE_REDIRECT_RESERVED"),
      from,
    );
  }
});

test("E-014 重复、自跳、链和环在 target 存在性检查前稳定失败", () => {
  assert.throws(
    () => parseRegistry([
      {from: "/old/", to: "/new/", reason: "一"},
      {from: "/old/", to: "/other/", reason: "二"},
    ]),
    hasCode("RELEASE_REDIRECT_SOURCE_DUPLICATE"),
  );
  assert.throws(
    () => parseRegistry([{from: "/old/", to: "/old/", reason: "自跳"}]),
    hasCode("RELEASE_REDIRECT_SELF"),
  );
  assert.throws(
    () => parseRegistry([
      {from: "/old/", to: "/middle/", reason: "第一跳"},
      {from: "/middle/", to: "/new/", reason: "第二跳"},
    ]),
    hasCode("RELEASE_REDIRECT_CHAIN"),
  );
  assert.throws(
    () => parseRegistry([
      {from: "/old/", to: "/middle/", reason: "第一跳"},
      {from: "/middle/", to: "/old/", reason: "回环"},
    ]),
    hasCode("RELEASE_REDIRECT_LOOP"),
  );
});

test("E-014 同 payload 拒绝静态 source HTML 与缺失 target", () => {
  assert.throws(
    () => compileRuntimeRedirectArtifacts({
      publicRoutes: ["/", "/old/", "/new/"],
      registry: parseRegistry([{from: "/old/", to: "/new/", reason: "审核说明"}]),
      canonicalOrigin: CANONICAL_ORIGIN,
    }),
    hasCode("RELEASE_REDIRECT_SOURCE_PAGE"),
  );
  assert.throws(
    () => compileRuntimeRedirectArtifacts({
      publicRoutes: ["/"],
      registry: parseRegistry([{from: "/old/", to: "/new/", reason: "审核说明"}]),
      canonicalOrigin: CANONICAL_ORIGIN,
    }),
    hasCode("RELEASE_REDIRECT_TARGET_MISSING"),
  );
});

test("E-014 HTML 提取拒绝非 index 页面、大小写路径、保留页面与链接成员", () => {
  for (const [path, code] of [
    ["about.html", "RELEASE_REDIRECT_HTML_LAYOUT"],
    ["About/index.html", "RELEASE_REDIRECT_ROUTE_PATH"],
    ["assets/manual/index.html", "RELEASE_REDIRECT_ROUTE_RESERVED"],
  ]) {
    withBuildFixture({
      "index.html": "<!doctype html>",
      [path]: "<!doctype html>",
    }, (root) => {
      assert.throws(() => collectPublicHtmlRoutes(root), hasCode(code));
    });
  }

  withBuildFixture({"index.html": "<!doctype html>"}, (root) => {
    symlinkSync(resolve(root, "index.html"), resolve(root, "linked.html"));
    assert.throws(
      () => collectPublicHtmlRoutes(root),
      hasCode("RELEASE_REDIRECT_BUILD_ENTRY"),
    );
  });
  withBuildFixture({"index.html": "<!doctype html>"}, (root) => {
    linkSync(resolve(root, "index.html"), resolve(root, "linked.txt"));
    assert.throws(
      () => collectPublicHtmlRoutes(root),
      hasCode("RELEASE_REDIRECT_BUILD_ENTRY"),
    );
  });
});

test("E-014 路由集合要求根页面、无重复且 canonical origin 不可覆盖", () => {
  assert.throws(
    () => compileRuntimeRedirectArtifacts({
      publicRoutes: ["/projects/"],
      registry: parseRegistry(),
      canonicalOrigin: CANONICAL_ORIGIN,
    }),
    hasCode("RELEASE_REDIRECT_ROUTE_ROOT"),
  );
  assert.throws(
    () => compileRuntimeRedirectArtifacts({
      publicRoutes: ["/", "/"],
      registry: parseRegistry(),
      canonicalOrigin: CANONICAL_ORIGIN,
    }),
    hasCode("RELEASE_REDIRECT_ROUTE_DUPLICATE"),
  );
  assert.throws(
    () => compileRuntimeRedirectArtifacts({
      publicRoutes: ["/"],
      registry: parseRegistry(),
      canonicalOrigin: "https://attacker.invalid",
    }),
    hasCode("RELEASE_REDIRECT_ORIGIN"),
  );
});

test("CODE-019 公共生成入口先拒绝提交、origin、任意 build 与额外参数", () => {
  withBuildFixture({"index.html": "<!doctype html>"}, (root) => {
    assert.throws(
      () => deriveRuntimeRedirectArtifacts({
        buildRoot: root,
        commitSha: "not-a-sha",
        canonicalOrigin: CANONICAL_ORIGIN,
      }),
      hasCode("RELEASE_REDIRECT_COMMIT"),
    );
    assert.throws(
      () => deriveRuntimeRedirectArtifacts({
        buildRoot: root,
        commitSha: "a".repeat(40),
        canonicalOrigin: "https://attacker.invalid",
      }),
      hasCode("RELEASE_REDIRECT_ORIGIN"),
    );
    assert.throws(
      () => deriveRuntimeRedirectArtifacts({
        buildRoot: root,
        commitSha: "a".repeat(40),
        canonicalOrigin: CANONICAL_ORIGIN,
      }),
      hasCode("RELEASE_REDIRECT_BUILD_ROOT"),
    );
    assert.throws(
      () => deriveRuntimeRedirectArtifacts({
        buildRoot: root,
        commitSha: "a".repeat(40),
        canonicalOrigin: CANONICAL_ORIGIN,
        registryPath: "/tmp/unapproved.json",
      }),
      hasCode("RELEASE_REDIRECT_INPUT"),
    );
  });
});

test("E-014 错误格式只暴露稳定 code 与仓库相对定位", () => {
  let caught;
  try {
    parseRegistry([{from: "/INVALID/", to: "/new/", reason: "审核说明"}]);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof RuntimeRedirectError);
  assert.equal(caught.stack, undefined);
  assert.match(
    formatRuntimeRedirectError(caught),
    /^\[RELEASE_REDIRECT_PATH\] \(docs\/contracts\/redirects\.json#redirects\[0\]\.from\) /u,
  );
  assert.doesNotMatch(formatRuntimeRedirectError(caught), /\/home\/|\/tmp\//u);
});

test("D-107 Nginx 验收只使用固定 linux/amd64 child manifest", () => {
  assert.equal(
    NGINX_ACCEPTANCE_IMAGE,
    "docker.io/library/nginx@sha256:0dcc88822d45581e65ae329f8be769762bf628d3b2bb7d2a077d4aa5c98b30e3",
  );
  assert.equal(NGINX_ACCEPTANCE_PLATFORM, "linux/amd64");
  assert.equal(NGINX_ACCEPTANCE_VERSION, "nginx/1.28.3");
  assert.doesNotMatch(
    NGINX_ACCEPTANCE_IMAGE,
    /^docker\.io\/library\/nginx:[^@]+$/u,
  );
});

test("D-107 HTTP 验收固定为四种 host/scheme 的 25 项精确矩阵", () => {
  const cases = buildNginxAcceptanceRequestCases({
    rootHttp: 8080,
    rootHttps: 8443,
    wwwHttp: 8081,
    wwwHttps: 8444,
  });
  assert.equal(cases.length, NGINX_ACCEPTANCE_HTTP_ASSERTION_COUNT);
  assert.deepEqual(cases, [
    {
      expectation: {
        location: "https://www.axialmuse.com/new/",
        statusCode: 301,
      },
      host: "axialmuse.com",
      path: "/old",
      port: 8080,
      protocol: "http:",
      role: "root-http",
    },
    {
      expectation: {
        location: "https://www.axialmuse.com/new/",
        statusCode: 301,
      },
      host: "axialmuse.com",
      path: "/old/",
      port: 8080,
      protocol: "http:",
      role: "root-http",
    },
    {
      expectation: {
        location: "https://www.axialmuse.com/projects/",
        statusCode: 301,
      },
      host: "axialmuse.com",
      path: "/projects",
      port: 8080,
      protocol: "http:",
      role: "root-http",
    },
    {
      expectation: {
        location:
          "https://www.axialmuse.com/new/?alpha=1&encoded=%2F&empty=",
        statusCode: 301,
      },
      host: "axialmuse.com",
      path: "/old?alpha=1&encoded=%2F&empty=",
      port: 8080,
      protocol: "http:",
      role: "root-http",
    },
    {
      expectation: {statusCode: 404},
      host: "unknown.invalid",
      path: "/old?unknown=1",
      port: 8080,
      protocol: "http:",
      role: "root-http",
    },
    {
      expectation: {
        location: "https://www.axialmuse.com/new/",
        statusCode: 301,
      },
      host: "www.axialmuse.com",
      path: "/old",
      port: 8081,
      protocol: "http:",
      role: "www-http",
    },
    {
      expectation: {
        location: "https://www.axialmuse.com/new/",
        statusCode: 301,
      },
      host: "www.axialmuse.com",
      path: "/old/",
      port: 8081,
      protocol: "http:",
      role: "www-http",
    },
    {
      expectation: {
        location: "https://www.axialmuse.com/projects/",
        statusCode: 301,
      },
      host: "www.axialmuse.com",
      path: "/projects",
      port: 8081,
      protocol: "http:",
      role: "www-http",
    },
    {
      expectation: {
        location:
          "https://www.axialmuse.com/new/?alpha=1&encoded=%2F&empty=",
        statusCode: 301,
      },
      host: "www.axialmuse.com",
      path: "/old?alpha=1&encoded=%2F&empty=",
      port: 8081,
      protocol: "http:",
      role: "www-http",
    },
    {
      expectation: {statusCode: 404},
      host: "unknown.invalid",
      path: "/old?unknown=1",
      port: 8081,
      protocol: "http:",
      role: "www-http",
    },
    {
      expectation: {
        location: "https://www.axialmuse.com/new/",
        statusCode: 301,
      },
      host: "axialmuse.com",
      path: "/old",
      port: 8443,
      protocol: "https:",
      role: "root-https",
    },
    {
      expectation: {
        location: "https://www.axialmuse.com/new/",
        statusCode: 301,
      },
      host: "axialmuse.com",
      path: "/old/",
      port: 8443,
      protocol: "https:",
      role: "root-https",
    },
    {
      expectation: {
        location: "https://www.axialmuse.com/projects/",
        statusCode: 301,
      },
      host: "axialmuse.com",
      path: "/projects",
      port: 8443,
      protocol: "https:",
      role: "root-https",
    },
    {
      expectation: {
        location:
          "https://www.axialmuse.com/new/?alpha=1&encoded=%2F&empty=",
        statusCode: 301,
      },
      host: "axialmuse.com",
      path: "/old?alpha=1&encoded=%2F&empty=",
      port: 8443,
      protocol: "https:",
      role: "root-https",
    },
    {
      expectation: {statusCode: 404},
      host: "unknown.invalid",
      path: "/old?unknown=1",
      port: 8443,
      protocol: "https:",
      role: "root-https",
    },
    {
      expectation: {
        location: "https://www.axialmuse.com/new/",
        statusCode: 301,
      },
      host: "www.axialmuse.com",
      path: "/old",
      port: 8444,
      protocol: "https:",
      role: "www-https",
    },
    {
      expectation: {
        location: "https://www.axialmuse.com/new/",
        statusCode: 301,
      },
      host: "www.axialmuse.com",
      path: "/old/",
      port: 8444,
      protocol: "https:",
      role: "www-https",
    },
    {
      expectation: {
        location: "https://www.axialmuse.com/projects/",
        statusCode: 301,
      },
      host: "www.axialmuse.com",
      path: "/projects",
      port: 8444,
      protocol: "https:",
      role: "www-https",
    },
    {
      expectation: {
        location:
          "https://www.axialmuse.com/new/?alpha=1&encoded=%2F&empty=",
        statusCode: 301,
      },
      host: "www.axialmuse.com",
      path: "/old?alpha=1&encoded=%2F&empty=",
      port: 8444,
      protocol: "https:",
      role: "www-https",
    },
    {
      expectation: {statusCode: 404},
      host: "unknown.invalid",
      path: "/old?unknown=1",
      port: 8444,
      protocol: "https:",
      role: "www-https",
    },
    {
      expectation: {
        body: "AXIAL_MUSE_ACME_ACCEPTANCE\n",
        statusCode: 200,
      },
      host: "axialmuse.com",
      path: "/.well-known/acme-challenge/axial-muse-nginx-acceptance",
      port: 8080,
      protocol: "http:",
      role: "root-http",
    },
    {
      expectation: {
        body: "AXIAL_MUSE_ACME_ACCEPTANCE\n",
        statusCode: 200,
      },
      host: "www.axialmuse.com",
      path: "/.well-known/acme-challenge/axial-muse-nginx-acceptance",
      port: 8081,
      protocol: "http:",
      role: "www-http",
    },
    {
      expectation: {
        body: "AXIAL_MUSE_ROOT_ACCEPTANCE\n",
        statusCode: 200,
      },
      host: "www.axialmuse.com",
      path: "/",
      port: 8444,
      protocol: "https:",
      role: "www-https",
    },
    {
      expectation: {
        body: "AXIAL_MUSE_NEW_TARGET_ACCEPTANCE\n",
        statusCode: 200,
      },
      host: "www.axialmuse.com",
      path: "/new/",
      port: 8444,
      protocol: "https:",
      role: "www-https",
    },
    {
      expectation: {
        body: "AXIAL_MUSE_PROJECTS_TARGET_ACCEPTANCE\n",
        statusCode: 200,
      },
      host: "www.axialmuse.com",
      path: "/projects/",
      port: 8444,
      protocol: "https:",
      role: "www-https",
    },
  ]);
});

test("D-107 四个 known server 只在 location 内兜底并共用派生 include", () => {
  const configuration = renderNginxAcceptanceConfiguration();
  assert.equal(configuration, `worker_processes 1;
pid /tmp/nginx.pid;
error_log stderr notice;

events {
  worker_connections 64;
}

http {
  access_log off;
  server_tokens off;
  default_type text/plain;
  index index.html;
  sendfile off;
  client_body_temp_path /tmp/client-body;
  proxy_temp_path /tmp/proxy;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  ssl_session_cache off;
  ssl_certificate /acceptance/tls/certificate.pem;
  ssl_certificate_key /acceptance/tls/private-key.pem;

server {
  listen 8080 default_server;
  server_name _;
  location / {
    return 404;
  }
}

server {
  listen 8080;
  server_name axialmuse.com;
  include /acceptance/config/redirects.conf;
  location ^~ /.well-known/acme-challenge/ {
    root /acceptance/acme-root;
    try_files $uri =404;
  }
  location / {
    return 301 https://www.axialmuse.com$request_uri;
  }
}

server {
  listen 8081 default_server;
  server_name _;
  location / {
    return 404;
  }
}

server {
  listen 8081;
  server_name www.axialmuse.com;
  include /acceptance/config/redirects.conf;
  location ^~ /.well-known/acme-challenge/ {
    root /acceptance/acme-root;
    try_files $uri =404;
  }
  location / {
    return 301 https://www.axialmuse.com$request_uri;
  }
}

server {
  listen 8443 ssl default_server;
  server_name _;
  location / {
    return 404;
  }
}

server {
  listen 8443 ssl;
  server_name axialmuse.com;
  include /acceptance/config/redirects.conf;
  location / {
    return 301 https://www.axialmuse.com$request_uri;
  }
}

server {
  listen 8444 ssl default_server;
  server_name _;
  location / {
    return 404;
  }
}

server {
  listen 8444 ssl;
  server_name www.axialmuse.com;
  include /acceptance/config/redirects.conf;
  root /acceptance/payload;
  location / {
    try_files $uri $uri/ =404;
  }
}
}
`);
  assert.equal(
    configuration.match(
      /^  include \/acceptance\/config\/redirects\.conf;$/gmu,
    )?.length,
    4,
  );
  assert.equal(configuration.match(/^server \{$/gmu)?.length, 8);
  assert.equal(configuration.match(/^  listen 8080;/gmu)?.length, 1);
  assert.equal(configuration.match(/^  listen 8081;/gmu)?.length, 1);
  assert.equal(configuration.match(/^  listen 8443 ssl;/gmu)?.length, 1);
  assert.equal(configuration.match(/^  listen 8444 ssl;/gmu)?.length, 1);
  assert.equal(
    configuration.match(
      /^  location \^~ \/\.well-known\/acme-challenge\/ \{$/gmu,
    )?.length,
    2,
  );
  assert.equal(configuration.match(/^  return 301 /gmu), null);
  assert.equal(configuration.includes("\nmap "), false);
  assert.equal(configuration.includes("\nif "), false);
  assert.equal(configuration.includes("location ~"), false);
});

test("D-107 服务容器参数固定 no-pull、最小权限、只读挂载且不发布宿主端口", () => {
  const arguments_ = buildNginxServiceCreateArguments({
    fixture: {
      acmeRoot: "/tmp/acceptance/acme",
      configRoot: "/tmp/acceptance/config",
      payloadRoot: "/tmp/acceptance/payload",
      tls: {
        certificatePath: "/tmp/acceptance/tls/certificate.pem",
      },
      tlsRoot: "/tmp/acceptance/tls",
    },
    labelValue: "a".repeat(32),
    name: "acceptance-service",
    network: "acceptance-internal",
  });
  assert.deepEqual(arguments_.slice(0, 2), ["container", "create"]);
  assert.equal(arguments_.includes("--pull"), true);
  assert.equal(
    arguments_[arguments_.indexOf("--pull") + 1],
    "never",
  );
  assert.equal(
    arguments_[arguments_.indexOf("--platform") + 1],
    "linux/amd64",
  );
  assert.equal(
    arguments_[arguments_.indexOf("--network") + 1],
    "acceptance-internal",
  );
  assert.equal(
    arguments_[arguments_.indexOf("--user") + 1],
    "65534:65534",
  );
  assert.equal(
    arguments_[arguments_.indexOf("--cap-drop") + 1],
    "ALL",
  );
  assert.equal(
    arguments_[arguments_.indexOf("--security-opt") + 1],
    "no-new-privileges=true",
  );
  assert.equal(arguments_.includes("--read-only"), true);
  assert.equal(arguments_.includes("--env"), false);
  assert.equal(arguments_.includes("-e"), false);
  assert.equal(arguments_.includes("--publish"), false);
  assert.equal(
    arguments_.filter((argument) => (
      argument.startsWith("type=bind,")
      && argument.endsWith(",readonly")
    )).length,
    5,
  );
  assert.deepEqual(
    arguments_.flatMap((argument, index) => (
      argument === "--add-host" ? [arguments_[index + 1]] : []
    )),
    [
      "axialmuse.com:127.0.0.1",
      "www.axialmuse.com:127.0.0.1",
      "unknown.invalid:127.0.0.1",
    ],
  );
  assert.equal(
    arguments_.filter((argument) => argument === NGINX_ACCEPTANCE_IMAGE)
      .length,
    1,
  );
  for (const injected of [
    ["--publish", "127.0.0.1:41080:8080"],
    ["--publish=127.0.0.1:41080:8080"],
    ["-p", "127.0.0.1:41080:8080"],
    ["-p127.0.0.1:41080:8080"],
    ["--publish-all"],
    ["--publish-all=true"],
    ["-P"],
    ["-dP"],
    ["--pull", "always"],
    ["--pull=always"],
  ]) {
    const mutated = [...arguments_];
    mutated.splice(mutated.indexOf(NGINX_ACCEPTANCE_IMAGE), 0, ...injected);
    assert.throws(
      () => assertPinnedNginxContainerArguments(mutated),
      (error) => error instanceof NginxDockerAcceptanceError
        && error.code === "NGINX_ACCEPTANCE_DOCKER_ARGUMENTS",
      injected.join(" "),
    );
  }
  const tagMutation = arguments_.map((argument) => (
    argument === NGINX_ACCEPTANCE_IMAGE
      ? "docker.io/library/nginx:1.28.3-alpine3.23"
      : argument
  ));
  assert.throws(
    () => assertPinnedNginxContainerArguments(tagMutation),
    (error) => error instanceof NginxDockerAcceptanceError
      && error.code === "NGINX_ACCEPTANCE_DOCKER_ARGUMENTS",
  );
});

function validContainerInspect() {
  return {
    Config: {User: "65534:65534"},
    HostConfig: {
      CapDrop: ["ALL"],
      NetworkMode: "acceptance-internal",
      PortBindings: null,
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges=true"],
    },
    NetworkSettings: {
      Ports: {
        "80/tcp": null,
      },
      Networks: {
        "acceptance-internal": {
          Gateway: "",
          IPAddress: "172.31.0.2",
          NetworkID: "a".repeat(64),
        },
      },
    },
  };
}

const DOCKER_ACCEPTANCE_RESOURCE_LABEL =
  "com.axialmuse.runtime-redirect-acceptance";
const NGINX_ACCEPTANCE_MANIFEST_DIGEST =
  NGINX_ACCEPTANCE_IMAGE.slice(NGINX_ACCEPTANCE_IMAGE.indexOf("@") + 1);
const NGINX_ACCEPTANCE_CONFIG_DIGEST = `sha256:${"e".repeat(64)}`;

function fakeCommandResult({
  status = 0,
  stderr = "",
  stdout = "",
} = {}) {
  return {
    error: undefined,
    signal: null,
    status,
    stderr,
    stdout,
  };
}

function optionValue(arguments_, option) {
  const index = arguments_.indexOf(option);
  assert.notEqual(index, -1, option);
  return arguments_[index + 1];
}

function createFakeNginxDocker({
  duplicateLocation = false,
  failFirstReadiness = false,
  mutateAfterHttp,
  onCleanup,
  onFinalHttp,
  onReadinessFailure,
  repoDigest = NGINX_ACCEPTANCE_MANIFEST_DIGEST,
} = {}) {
  const calls = [];
  const containers = new Map();
  const fixtureDirectoryModes = [];
  const networkId = "b".repeat(64);
  let cleanupNotified = false;
  let httpRequestCount = 0;
  let wgetAttemptCount = 0;
  let network;
  let temporaryRootMode;

  function notFound(kind, name) {
    return fakeCommandResult({
      status: 1,
      stdout: "[]\n",
      stderr: kind === "container"
        ? `Error response from daemon: No such container: ${name}\n`
        : `Error response from daemon: network ${name} not found\n`,
    });
  }

  function containerDocument(arguments_, running = false) {
    const name = optionValue(arguments_, "--name");
    const label = optionValue(arguments_, "--label").split("=")[1];
    const networkName = optionValue(arguments_, "--network");
    const id = name.endsWith("-service") ? "c".repeat(64) : "d".repeat(64);
    const service = name.endsWith("-service");
    return {
      Config: {
        Labels: {[DOCKER_ACCEPTANCE_RESOURCE_LABEL]: label},
        User: "65534:65534",
      },
      HostConfig: {
        CapDrop: ["ALL"],
        NetworkMode: networkName,
        PortBindings: null,
        ReadonlyRootfs: true,
        SecurityOpt: ["no-new-privileges=true"],
      },
      Id: id,
      Image: NGINX_ACCEPTANCE_CONFIG_DIGEST,
      ImageManifestDescriptor: {
        digest: NGINX_ACCEPTANCE_MANIFEST_DIGEST,
        platform: {
          architecture: "amd64",
          os: "linux",
        },
      },
      NetworkSettings: {
        Networks: service
          ? {
            [networkName]: {
              Gateway: "",
              IPAddress: "172.31.0.2",
              NetworkID: networkId,
            },
          }
          : {},
        Ports: service
          ? {
            "8080/tcp": null,
            "8081/tcp": null,
            "8443/tcp": null,
            "8444/tcp": null,
          }
          : {},
      },
      State: {Running: running},
    };
  }

  function networkDocument() {
    assert.ok(network);
    return {
      Containers: {
        ...Object.fromEntries(
          [...containers.entries()]
            .filter(([, document]) => (
              document.State.Running
              && document.HostConfig.NetworkMode === network.name
            ))
            .map(([name, document]) => [
              document.Id,
              {
                IPv4Address:
                  `${document.NetworkSettings.Networks[network.name].IPAddress}/16`,
                Name: name,
              },
            ]),
        ),
        ...network.extraMembers,
      },
      Driver: "bridge",
      EnableIPv6: false,
      Id: networkId,
      Internal: true,
      Labels: {
        [DOCKER_ACCEPTANCE_RESOURCE_LABEL]: network.label,
      },
      Name: network.name,
    };
  }

  function recordFixtureDirectoryModes(dockerArguments) {
    const directories = [];
    for (let index = 0; index < dockerArguments.length; index += 1) {
      if (dockerArguments[index] !== "--mount") continue;
      const fields = dockerArguments[index + 1].split(",");
      const source = fields
        .find((field) => field.startsWith("src="))
        ?.slice("src=".length);
      if (
        source !== undefined
        && fs.lstatSync(source).isDirectory()
      ) {
        directories.push(source);
      }
    }
    assert.ok(directories.length > 0);
    temporaryRootMode = fs.lstatSync(dirname(directories[0])).mode & 0o777;
    const visit = (directory) => {
      fixtureDirectoryModes.push(fs.lstatSync(directory).mode & 0o777);
      for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
        if (entry.isDirectory()) visit(resolve(directory, entry.name));
      }
    };
    for (const directory of directories) visit(directory);
  }

  function wgetResult(urlText) {
    const url = new URL(urlText);
    let body = "";
    let location;
    let statusCode;
    if (url.hostname === "unknown.invalid") {
      statusCode = 404;
    } else if (
      url.pathname
      === "/.well-known/acme-challenge/axial-muse-nginx-acceptance"
    ) {
      statusCode = 200;
      body = "AXIAL_MUSE_ACME_ACCEPTANCE\n";
    } else if (url.pathname === "/old" || url.pathname === "/old/") {
      statusCode = 301;
      location = `https://www.axialmuse.com/new/${url.search}`;
    } else if (url.pathname === "/projects") {
      statusCode = 301;
      location = "https://www.axialmuse.com/projects/";
    } else {
      const targets = {
        "/": "AXIAL_MUSE_ROOT_ACCEPTANCE\n",
        "/new/": "AXIAL_MUSE_NEW_TARGET_ACCEPTANCE\n",
        "/projects/": "AXIAL_MUSE_PROJECTS_TARGET_ACCEPTANCE\n",
      };
      assert.ok(Object.hasOwn(targets, url.pathname), urlText);
      statusCode = 200;
      body = targets[url.pathname];
    }
    const statusText = statusCode === 200
      ? "OK"
      : statusCode === 301
        ? "Moved Permanently"
        : "Not Found";
    const locationHeaders = location === undefined
      ? ""
      : `  Location: ${location}\n`
        + (
          duplicateLocation && url.pathname === "/old"
            ? `  Location: ${location}\n`
            : ""
        );
    return fakeCommandResult({
      status: statusCode === 200 ? 0 : 1,
      stdout: body,
      stderr: `Connecting to ${url.host} (127.0.0.1:${url.port})
  HTTP/1.1 ${statusCode} ${statusText}
  Server: nginx
${locationHeaders}Connection closed
`,
    });
  }

  async function spawnProcess(command, arguments_) {
    calls.push({arguments_: [...arguments_], command});
    if (command === "/usr/bin/openssl") {
      writeFileSync(optionValue(arguments_, "-keyout"), "private-key\n");
      writeFileSync(optionValue(arguments_, "-out"), "certificate\n");
      return fakeCommandResult();
    }
    assert.equal(command, "/usr/bin/docker");
    assert.equal(arguments_[0], "--config");
    assert.equal(arguments_[2], "--host");
    assert.equal(arguments_[3], "unix:///var/run/docker.sock");
    const dockerArguments = arguments_.slice(4);
    if (dockerArguments[0] === "version") {
      return fakeCommandResult({stdout: "\"29.3.1\"\n"});
    }
    if (
      dockerArguments[0] === "image"
      && dockerArguments[1] === "inspect"
    ) {
      assert.deepEqual(dockerArguments, [
        "image",
        "inspect",
        NGINX_ACCEPTANCE_IMAGE,
      ]);
      return fakeCommandResult({
        stdout: `${JSON.stringify([{
          Architecture: "amd64",
          Id: NGINX_ACCEPTANCE_CONFIG_DIGEST,
          Os: "linux",
          RepoDigests: [
            `nginx@${repoDigest}`,
          ],
        }])}\n`,
      });
    }
    if (
      dockerArguments[0] === "container"
      && dockerArguments[1] === "inspect"
    ) {
      const name = dockerArguments[2];
      return containers.has(name)
        ? fakeCommandResult({
          stdout: `${JSON.stringify([containers.get(name)])}\n`,
        })
        : notFound("container", name);
    }
    if (
      dockerArguments[0] === "container"
      && dockerArguments[1] === "run"
    ) {
      assertPinnedNginxContainerArguments(dockerArguments);
      const name = optionValue(dockerArguments, "--name");
      containers.set(name, containerDocument(dockerArguments));
      const imageIndex = dockerArguments.indexOf(NGINX_ACCEPTANCE_IMAGE);
      if (dockerArguments[imageIndex + 1] === "-t") {
        recordFixtureDirectoryModes(dockerArguments);
      }
      return dockerArguments[imageIndex + 1] === "-v"
        ? fakeCommandResult({
          stderr: `nginx version: ${NGINX_ACCEPTANCE_VERSION}\n`,
        })
        : fakeCommandResult();
    }
    if (
      dockerArguments[0] === "network"
      && dockerArguments[1] === "inspect"
    ) {
      return network?.name === dockerArguments[2]
        ? fakeCommandResult({
          stdout: `${JSON.stringify([networkDocument()])}\n`,
        })
        : notFound("network", dockerArguments[2]);
    }
    if (
      dockerArguments[0] === "network"
      && dockerArguments[1] === "create"
    ) {
      network = {
        extraMembers: {},
        label: optionValue(dockerArguments, "--label").split("=")[1],
        name: dockerArguments.at(-1),
      };
      return fakeCommandResult({stdout: `${networkId}\n`});
    }
    if (
      dockerArguments[0] === "container"
      && dockerArguments[1] === "create"
    ) {
      assertPinnedNginxContainerArguments(dockerArguments);
      const name = optionValue(dockerArguments, "--name");
      containers.set(name, containerDocument(dockerArguments));
      return fakeCommandResult({stdout: `${containers.get(name).Id}\n`});
    }
    if (
      dockerArguments[0] === "container"
      && dockerArguments[1] === "start"
    ) {
      const document = containers.get(dockerArguments[2]);
      assert.ok(document);
      document.State.Running = true;
      return fakeCommandResult({stdout: `${dockerArguments[2]}\n`});
    }
    if (
      dockerArguments[0] === "container"
      && dockerArguments[1] === "exec"
    ) {
      wgetAttemptCount += 1;
      if (failFirstReadiness && wgetAttemptCount === 1) {
        onReadinessFailure?.();
        return fakeCommandResult({
          status: 1,
          stderr: "wget: connection refused\n",
        });
      }
      const result = wgetResult(dockerArguments.at(-1));
      httpRequestCount += 1;
      if (
        httpRequestCount
        === NGINX_ACCEPTANCE_HTTP_ASSERTION_COUNT + 1
      ) {
        mutateAfterHttp?.({containers, network});
        onFinalHttp?.();
      }
      return result;
    }
    if (
      dockerArguments[0] === "container"
      && dockerArguments[1] === "rm"
    ) {
      if (!cleanupNotified) {
        cleanupNotified = true;
        onCleanup?.();
      }
      containers.delete(dockerArguments.at(-1));
      return fakeCommandResult();
    }
    if (
      dockerArguments[0] === "network"
      && dockerArguments[1] === "rm"
    ) {
      network = undefined;
      return fakeCommandResult();
    }
    assert.fail(`unexpected Docker call: ${dockerArguments.join(" ")}`);
  }

  return {
    calls,
    containers,
    fixtureDirectoryModes,
    hasNetwork: () => network !== undefined,
    httpAttemptCount: () => wgetAttemptCount,
    spawnProcess,
    temporaryRootMode: () => temporaryRootMode,
  };
}

test("D-107 只接受无宿主发布且唯一内部 IPv4 的硬化容器事实", () => {
  assert.deepEqual(
    extractInternalServiceEndpoint(
      validContainerInspect(),
      "acceptance-internal",
    ),
    {
      address: "172.31.0.2",
      networkId: "a".repeat(64),
      ports: {
        rootHttp: 8080,
        rootHttps: 8443,
        wwwHttp: 8081,
        wwwHttps: 8444,
      },
    },
  );
  for (const mutate of [
    (document) => {
      document.HostConfig.PortBindings = {
        "8080/tcp": [{HostIp: "127.0.0.1", HostPort: "41080"}],
      };
    },
    (document) => {
      document.NetworkSettings.Ports["8080/tcp"] =
        [{HostIp: "127.0.0.1", HostPort: "41080"}];
    },
    (document) => {
      document.NetworkSettings.Networks.other = {
        Gateway: "",
        IPAddress: "172.31.1.2",
        NetworkID: "b".repeat(64),
      };
    },
    (document) => {
      document.NetworkSettings.Networks["acceptance-internal"].IPAddress =
        "not-an-ip";
    },
    (document) => {
      document.HostConfig.CapDrop = [];
    },
    (document) => {
      document.HostConfig.ReadonlyRootfs = false;
    },
  ]) {
    const document = structuredClone(validContainerInspect());
    mutate(document);
    assert.throws(
      () => extractInternalServiceEndpoint(
        document,
        "acceptance-internal",
      ),
      (error) => error instanceof NginxDockerAcceptanceError,
    );
  }
});

test("D-107 HTTP 断言读取 rawHeaders 并拒绝重复或错误 Location", () => {
  assert.doesNotThrow(() => assertAcceptanceHttpResponse({
    body: "",
    rawHeaders: [
      "Server",
      "nginx",
      "Location",
      "https://www.axialmuse.com/new/?query=1",
    ],
    statusCode: 301,
  }, {
    location: "https://www.axialmuse.com/new/?query=1",
    statusCode: 301,
  }));
  for (const rawHeaders of [
    [
      "Location",
      "https://www.axialmuse.com/new/?query=1",
      "location",
      "https://www.axialmuse.com/new/?query=1",
    ],
    ["Location", "https://attacker.invalid/"],
    ["Server", "nginx"],
  ]) {
    assert.throws(
      () => assertAcceptanceHttpResponse({
        body: "",
        rawHeaders,
        statusCode: 301,
      }, {
        location: "https://www.axialmuse.com/new/?query=1",
        statusCode: 301,
      }),
      (error) => error instanceof NginxDockerAcceptanceError
        && error.code === "NGINX_ACCEPTANCE_HTTP",
    );
  }
});

test("D-107 BusyBox wget 首响应解析保留重复 header 且拒绝二次 HTTP 响应", () => {
  assert.deepEqual(parseBusyBoxWgetResponse({
    error: undefined,
    signal: null,
    status: 1,
    stderr: `Connecting to www.axialmuse.com:8444 (127.0.0.1:8444)
  HTTP/1.1 301 Moved Permanently
  Server: nginx
  Location: https://www.axialmuse.com/new/?query=1
  Location: https://www.axialmuse.com/new/?query=1
Connecting to www.axialmuse.com (127.0.0.1:443)
wget: can't connect to remote host (127.0.0.1): Connection refused
`,
    stdout: "",
  }), {
    body: "",
    exitStatus: 1,
    rawHeaders: [
      "Server",
      "nginx",
      "Location",
      "https://www.axialmuse.com/new/?query=1",
      "Location",
      "https://www.axialmuse.com/new/?query=1",
    ],
    statusCode: 301,
  });
  assert.throws(
    () => parseBusyBoxWgetResponse({
      error: undefined,
      signal: null,
      status: 0,
      stderr: `  HTTP/1.1 301 Moved Permanently
  Location: https://www.axialmuse.com/new/
  HTTP/1.1 200 OK
  Content-Type: text/plain
`,
      stdout: "",
    }),
    (error) => error instanceof NginxDockerAcceptanceError
      && error.code === "NGINX_ACCEPTANCE_HTTP",
  );
});

function fakeAcceptanceOptions(fake, overrides = {}) {
  return {
    architecture: "x64",
    arguments_: [],
    assertExecutableIdentity() {},
    currentWorkingDirectory: process.cwd(),
    environmentSource: {},
    nodeVersion: "24.18.0",
    platform: "linux",
    repositoryRoot: process.cwd(),
    spawnProcess: fake.spawnProcess,
    ...overrides,
  };
}

test("D-107 fake Docker 编排固定 inspect、version、nginx-t 与 service 镜像参数", async () => {
  const fake = createFakeNginxDocker();
  const result = await runNginxDockerAcceptance(
    fakeAcceptanceOptions(fake),
  );
  assert.equal(
    result.assertionCount,
    NGINX_ACCEPTANCE_HTTP_ASSERTION_COUNT,
  );
  assert.equal(result.imageDigest, NGINX_ACCEPTANCE_IMAGE);
  assert.equal(result.imageId, NGINX_ACCEPTANCE_CONFIG_DIGEST);
  assert.notEqual(result.imageId, NGINX_ACCEPTANCE_MANIFEST_DIGEST);
  const dockerCalls = fake.calls
    .filter((call) => call.command === "/usr/bin/docker")
    .map((call) => call.arguments_.slice(4));
  assert.equal(
    dockerCalls.filter((arguments_) => (
      arguments_[0] === "image"
      && arguments_[1] === "inspect"
    )).length,
    1,
  );
  assert.deepEqual(
    dockerCalls.find((arguments_) => arguments_[0] === "image"),
    ["image", "inspect", NGINX_ACCEPTANCE_IMAGE],
  );
  const imageCommands = dockerCalls.filter((arguments_) => (
    arguments_[0] === "container"
    && ["create", "run"].includes(arguments_[1])
  ));
  assert.equal(imageCommands.length, 3);
  for (const arguments_ of imageCommands) {
    assert.doesNotThrow(
      () => assertPinnedNginxContainerArguments(arguments_),
    );
    assert.equal(
      arguments_.filter((argument) => argument === "--pull").length,
      1,
    );
    assert.equal(
      arguments_[arguments_.indexOf("--pull") + 1],
      "never",
    );
    assert.equal(
      arguments_.filter(
        (argument) => argument === NGINX_ACCEPTANCE_IMAGE,
      ).length,
      1,
    );
  }
  const commandSuffixes = imageCommands.map((arguments_) => (
    arguments_.slice(arguments_.indexOf(NGINX_ACCEPTANCE_IMAGE) + 1)
  ));
  assert.ok(commandSuffixes.some((suffix) => (
    suffix.length === 1 && suffix[0] === "-v"
  )));
  assert.ok(commandSuffixes.some((suffix) => (
    suffix[0] === "-t"
    && suffix[1] === "-c"
    && suffix[2] === "/acceptance/config/nginx.conf"
  )));
  assert.ok(commandSuffixes.some((suffix) => (
    suffix[0] === "-c"
    && suffix[1] === "/acceptance/config/nginx.conf"
    && suffix[2] === "-g"
    && suffix[3] === "daemon off;"
  )));
  assert.equal(fake.containers.size, 0);
  assert.equal(fake.hasNetwork(), false);
});

test("D-107 image config digest 与 child manifest 分离并分别绑定", async () => {
  const fake = createFakeNginxDocker({
    repoDigest: NGINX_ACCEPTANCE_CONFIG_DIGEST,
  });
  await assert.rejects(
    runNginxDockerAcceptance(fakeAcceptanceOptions(fake, {
      signalTarget: new EventEmitter(),
    })),
    (error) => error instanceof NginxDockerAcceptanceError
      && error.code === "NGINX_ACCEPTANCE_IMAGE",
  );
  assert.equal(fake.containers.size, 0);
  assert.equal(fake.hasNetwork(), false);
});

test("D-107 HTTP 后重新绑定 container、image、network 与唯一成员", async () => {
  const cases = [
    {
      code: "NGINX_ACCEPTANCE_DOCKER_SERVICE",
      mutate({containers}) {
        const service = [...containers.values()]
          .find((document) => document.State.Running);
        service.Id = "f".repeat(64);
      },
    },
    {
      code: "NGINX_ACCEPTANCE_DOCKER_SERVICE",
      mutate({containers}) {
        const service = [...containers.values()]
          .find((document) => document.State.Running);
        service.Image = NGINX_ACCEPTANCE_MANIFEST_DIGEST;
      },
    },
    {
      code: "NGINX_ACCEPTANCE_DOCKER_NETWORK",
      mutate({containers}) {
        const service = [...containers.values()]
          .find((document) => document.State.Running);
        service.NetworkSettings.Networks.external = {
          Gateway: "172.32.0.1",
          IPAddress: "172.32.0.2",
          NetworkID: "a".repeat(64),
        };
      },
    },
    {
      code: "NGINX_ACCEPTANCE_DOCKER_NETWORK",
      mutate({containers}) {
        const service = [...containers.values()]
          .find((document) => document.State.Running);
        const [endpoint] = Object.values(service.NetworkSettings.Networks);
        endpoint.IPAddress = "172.31.0.9";
      },
    },
    {
      code: "NGINX_ACCEPTANCE_DOCKER_NETWORK",
      mutate({network}) {
        network.extraMembers["a".repeat(64)] = {
          IPv4Address: "172.31.0.3/16",
          Name: "foreign-member",
        };
      },
    },
  ];
  for (const testCase of cases) {
    const fake = createFakeNginxDocker({
      mutateAfterHttp: testCase.mutate,
    });
    await assert.rejects(
      runNginxDockerAcceptance(fakeAcceptanceOptions(fake, {
        signalTarget: new EventEmitter(),
      })),
      (error) => error instanceof NginxDockerAcceptanceError
        && error.code === testCase.code,
      testCase.code,
    );
    assert.equal(fake.containers.size, 0);
    assert.equal(fake.hasNetwork(), false);
  }
});

test("D-107 最后请求或清理期间的 signal 均失败关闭且移除监听", async () => {
  for (const phase of ["final-http", "cleanup"]) {
    const signalTarget = new EventEmitter();
    const fake = createFakeNginxDocker({
      onCleanup: phase === "cleanup"
        ? () => signalTarget.emit("SIGTERM")
        : undefined,
      onFinalHttp: phase === "final-http"
        ? () => signalTarget.emit("SIGINT")
        : undefined,
    });
    await assert.rejects(
      runNginxDockerAcceptance(fakeAcceptanceOptions(fake, {signalTarget})),
      (error) => error instanceof NginxDockerAcceptanceError
        && error.code === "NGINX_ACCEPTANCE_INTERRUPTED",
      phase,
    );
    assert.equal(signalTarget.listenerCount("SIGINT"), 0);
    assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
    assert.equal(fake.containers.size, 0);
    assert.equal(fake.hasNetwork(), false);
  }
});

test("D-107 readiness 异步退避可被 signal 立即取消", async () => {
  const signalTarget = new EventEmitter();
  const fake = createFakeNginxDocker({
    failFirstReadiness: true,
    onReadinessFailure() {
      setImmediate(() => signalTarget.emit("SIGTERM"));
    },
  });
  await assert.rejects(
    runNginxDockerAcceptance(fakeAcceptanceOptions(fake, {signalTarget})),
    (error) => error instanceof NginxDockerAcceptanceError
      && error.code === "NGINX_ACCEPTANCE_INTERRUPTED",
  );
  assert.equal(fake.httpAttemptCount(), 1);
  assert.equal(fake.containers.size, 0);
  assert.equal(fake.hasNetwork(), false);
  assert.equal(signalTarget.listenerCount("SIGINT"), 0);
  assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
});

function runParentSignalProbe(signalName) {
  const acceptanceModuleUrl = new URL(
    "../../scripts/release/lib/nginx-docker-acceptance.mjs",
    import.meta.url,
  ).href;
  const repositoryRoot = process.cwd();
  const source = `
import {
  NginxDockerAcceptanceError,
  runNginxDockerAcceptance,
} from ${JSON.stringify(acceptanceModuleUrl)};
import {writeSync} from "node:fs";

let commandStarted = false;
try {
  await runNginxDockerAcceptance({
    architecture: "x64",
    arguments_: [],
    assertExecutableIdentity() {},
    currentWorkingDirectory: ${JSON.stringify(repositoryRoot)},
    environmentSource: {},
    nodeVersion: "24.18.0",
    platform: "linux",
    repositoryRoot: ${JSON.stringify(repositoryRoot)},
    signalTarget: process,
    spawnProcess(_command, _arguments, options) {
      if (commandStarted) {
        throw new Error("unexpected command after interruption");
      }
      commandStarted = true;
      writeSync(1, "SIGNAL_READY\\n");
      return new Promise((resolveCommand) => {
        const keepAlive = setInterval(() => {}, 1_000);
        const interrupted = () => {
          clearInterval(keepAlive);
          resolveCommand({
            error: options.signal?.reason,
            signal: "SIGTERM",
            status: null,
            stderr: "",
            stdout: "",
          });
        };
        if (options.signal?.aborted) {
          interrupted();
        } else {
          options.signal?.addEventListener("abort", interrupted, {once: true});
        }
      });
    },
  });
  writeSync(1, "FALSE_SUCCESS\\n");
  process.exitCode = 70;
} catch (error) {
  if (
    error instanceof NginxDockerAcceptanceError
    && error.code === "NGINX_ACCEPTANCE_INTERRUPTED"
  ) {
    writeSync(1, "INTERRUPTED\\n");
    process.exitCode = 73;
  } else {
    writeSync(2, \`UNEXPECTED:\${error?.code ?? error?.name}\\n\`);
    process.exitCode = 74;
  }
}
`;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      cwd: repositoryRoot,
      env: {
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: "/usr/bin:/bin",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  return new Promise((resolveProbe, rejectProbe) => {
    let signalSent = false;
    let stderr = "";
    let stdout = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectProbe(new Error(
        `signal probe timed out: ${signalName}; `
        + `stdout=${JSON.stringify(stdout)}; `
        + `stderr=${JSON.stringify(stderr)}`,
      ));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!signalSent && stdout.includes("SIGNAL_READY\n")) {
        signalSent = true;
        if (!child.kill(signalName)) {
          child.kill("SIGKILL");
          clearTimeout(timeout);
          rejectProbe(new Error(`signal probe could not send ${signalName}`));
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectProbe(error);
    });
    child.once("close", (code, closeSignal) => {
      clearTimeout(timeout);
      resolveProbe({
        closeSignal,
        code,
        signalSent,
        stderr,
        stdout,
      });
    });
  });
}

test("D-107 父进程真实 SIGINT/SIGTERM 在异步命令期间取消并失败关闭", async () => {
  for (const signalName of ["SIGINT", "SIGTERM"]) {
    const result = await runParentSignalProbe(signalName);
    assert.equal(
      result.signalSent,
      true,
      `${signalName}: ${JSON.stringify(result)}`,
    );
    assert.equal(result.closeSignal, null, signalName);
    assert.equal(result.code, 73, signalName);
    assert.equal(
      result.stdout,
      "SIGNAL_READY\nINTERRUPTED\n",
      signalName,
    );
    assert.equal(result.stderr, "", signalName);
  }
});

test("D-107 setup 失败仍清理临时根，并按 operation-first 聚合清理失败", async () => {
  const operationFailure = new Error("setup operation sentinel");
  let temporaryRoot;
  const fake = createFakeNginxDocker();
  const signalTarget = new EventEmitter();
  await assert.rejects(
    runNginxDockerAcceptance(fakeAcceptanceOptions(fake, {
      createRandomBytes() {
        throw operationFailure;
      },
      createTemporaryDirectory(prefix) {
        temporaryRoot = mkdtempSync(prefix);
        return temporaryRoot;
      },
      signalTarget,
    })),
    (error) => error === operationFailure,
  );
  assert.throws(
    () => fs.lstatSync(temporaryRoot),
    (error) => error?.code === "ENOENT",
  );
  assert.equal(signalTarget.listenerCount("SIGINT"), 0);
  assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
  assert.equal(fake.calls.length, 0);

  const cleanupFailure = new Error("setup cleanup sentinel");
  let aggregateRoot;
  await assert.rejects(
    runNginxDockerAcceptance(fakeAcceptanceOptions(fake, {
      createRandomBytes() {
        throw operationFailure;
      },
      createTemporaryDirectory(prefix) {
        aggregateRoot = mkdtempSync(prefix);
        return aggregateRoot;
      },
      removeTemporaryDirectory(path, options) {
        rmSync(path, options);
        throw cleanupFailure;
      },
      signalTarget,
    })),
    (error) => (
      error instanceof NginxDockerAcceptanceError
      && error.code === "NGINX_ACCEPTANCE_OPERATION_AND_CLEANUP"
      && error.cause instanceof AggregateError
      && error.cause.errors[0] === operationFailure
      && error.cause.errors[1] === cleanupFailure
    ),
  );
  assert.throws(
    () => fs.lstatSync(aggregateRoot),
    (error) => error?.code === "ENOENT",
  );
});

test("D-107 fixture 目录在 umask 0077 下仍显式为 0755", async () => {
  const previousUmask = process.umask(0o077);
  const fake = createFakeNginxDocker();
  try {
    await runNginxDockerAcceptance(fakeAcceptanceOptions(fake, {
      signalTarget: new EventEmitter(),
    }));
  } finally {
    process.umask(previousUmask);
  }
  assert.equal(fake.temporaryRootMode(), 0o700);
  assert.ok(fake.fixtureDirectoryModes.length >= 8);
  assert.equal(
    fake.fixtureDirectoryModes.every((mode) => mode === 0o755),
    true,
  );
});

test("D-107 重复 Location 从 raw wget stderr 贯穿真实 runner 并失败清理", async () => {
  const fake = createFakeNginxDocker({duplicateLocation: true});
  await assert.rejects(
    runNginxDockerAcceptance(fakeAcceptanceOptions(fake)),
    (error) => error instanceof NginxDockerAcceptanceError
      && error.code === "NGINX_ACCEPTANCE_HTTP",
  );
  assert.equal(fake.containers.size, 0);
  assert.equal(fake.hasNetwork(), false);
});

test("D-107 真实 Docker 入口不进入 quality、package、hook、workflow 或共享测试", () => {
  for (const sourcePath of [
    "package.json",
    "scripts/quality/run-quality.mjs",
    "scripts/quality/run-tests.mjs",
    ".githooks/pre-commit",
    ".github/workflows/ci.yml",
  ]) {
    const source = fs.readFileSync(resolve(process.cwd(), sourcePath), "utf8");
    assert.equal(
      source.includes("check-runtime-redirects-nginx.mjs"),
      false,
      sourcePath,
    );
    assert.equal(
      source.includes("nginx-docker-acceptance.mjs"),
      false,
      sourcePath,
    );
  }
});
