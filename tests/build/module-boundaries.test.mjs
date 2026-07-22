import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import test from "node:test";
import {checkModuleBoundaries} from "../../scripts/quality/check-module-boundaries.mjs";

const TSCONFIG = {
  extends: "@docusaurus/tsconfig",
  compilerOptions: {
    baseUrl: ".",
    ignoreDeprecations: "6.0",
    strict: true,
    allowJs: false,
  },
  include: [
    "docusaurus.config.ts",
    "sidebars.ts",
    "src/**/*.ts",
    "src/**/*.tsx",
  ],
};

function writeFixture(root, relativePath, contents) {
  const path = resolve(root, relativePath);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, contents, "utf8");
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-module-boundaries-"));
  writeFixture(root, ".nvmrc", "24.18.0\n");
  writeFixture(root, "package.json", `${JSON.stringify({
    name: "module-boundary-fixture",
    private: true,
    scripts: {
      typecheck: "tsc --noEmit",
      build: "node scripts/build/build-site.mjs --mode production",
    },
    dependencies: {
      "@docusaurus/core": "3.10.2",
      react: "^19.0.0",
    },
    devDependencies: {
      "@docusaurus/tsconfig": "3.10.2",
      "@docusaurus/types": "3.10.2",
    },
    engines: {
      node: ">=24.16.0 <25",
    },
  }, null, 2)}\n`);
  writeFixture(root, "tsconfig.json", `${JSON.stringify(TSCONFIG, null, 2)}\n`);
  writeFixture(
    root,
    "docusaurus.config.ts",
    "import type {Config} from \"@docusaurus/types\";\nconst config: Config = {} as Config;\nexport default config;\n",
  );
  writeFixture(
    root,
    "sidebars.ts",
    "import type {SidebarsConfig} from \"@docusaurus/plugin-content-docs\";\nconst sidebars: SidebarsConfig = {};\nexport default sidebars;\n",
  );
  writeFixture(
    root,
    "src/domain/example/rules.ts",
    "export const exampleRule = \"ok\";\n",
  );
  writeFixture(
    root,
    "src/domain/example/index.ts",
    "export {exampleRule} from \"./rules.js\";\n",
  );
  writeFixture(
    root,
    "src/build/example/use-domain.ts",
    "import {exampleRule} from \"../../domain/example/index.js\";\nexport const buildValue = exampleRule;\n",
  );
  writeFixture(
    root,
    "src/components/Card/index.tsx",
    "export function Card() { return <p>fixture</p>; }\n",
  );
  writeFixture(
    root,
    "src/pages/Home.tsx",
    "import Layout from \"@theme/Layout\";\nimport {Card} from \"@site/src/components/Card/index.js\";\nexport default function Home() { return <Layout><Card /></Layout>; }\n",
  );
  return root;
}

function withFixture(callback) {
  const root = createFixture();
  try {
    callback(root);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

function issueCodes(root) {
  return checkModuleBoundaries({root}).issues.map((issue) => issue.code);
}

test("D-075 合法公共入口、框架默认导出与官方展示别名通过", () => {
  withFixture((root) => {
    const result = checkModuleBoundaries({root});
    assert.deepEqual(result.issues, []);
    assert.equal(result.files.length, 7);
  });
});

test("D-076 拒绝 paths 和根 TypeScript 配置漂移", () => {
  withFixture((root) => {
    writeFixture(root, "tsconfig.json", `${JSON.stringify({
      ...TSCONFIG,
      compilerOptions: {
        ...TSCONFIG.compilerOptions,
        paths: {"@domain/*": ["src/domain/*"]},
      },
    }, null, 2)}\n`);
    assert.ok(issueCodes(root).includes("MODULE_BOUNDARY_TSCONFIG_OPTIONS"));
  });
});

test("I-04 拒绝根 package module type 改写 Docusaurus 生成文件语义", () => {
  withFixture((root) => {
    const manifestPath = resolve(root, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFixture(root, "package.json", `${JSON.stringify({
      ...manifest,
      type: "module",
    }, null, 2)}\n`);
    assert.ok(issueCodes(root).includes("MODULE_BOUNDARY_PACKAGE_TYPE"));
  });
});

test("D-074 拒绝目标源码中的 JavaScript", () => {
  withFixture((root) => {
    writeFixture(root, "src/build/example/legacy.js", "export const legacy = true;\n");
    assert.ok(issueCodes(root).includes("MODULE_BOUNDARY_SOURCE_EXTENSION"));
  });
});

test("D-075 拒绝跨层深导入", () => {
  withFixture((root) => {
    writeFixture(
      root,
      "src/build/example/use-domain.ts",
      "import {exampleRule} from \"../../domain/example/rules.js\";\nexport const buildValue = exampleRule;\n",
    );
    assert.ok(issueCodes(root).includes("MODULE_BOUNDARY_DEEP_IMPORT"));
  });
});

test("D-075 拒绝 export star", () => {
  withFixture((root) => {
    writeFixture(root, "src/domain/example/index.ts", "export * from \"./rules.js\";\n");
    assert.ok(issueCodes(root).includes("MODULE_BOUNDARY_EXPORT_STAR"));
  });
});

test("D-075 拒绝自定义业务路径别名", () => {
  withFixture((root) => {
    writeFixture(
      root,
      "src/build/example/use-domain.ts",
      "import {exampleRule} from \"@domain/example\";\nexport const buildValue = exampleRule;\n",
    );
    assert.ok(issueCodes(root).includes("MODULE_BOUNDARY_CUSTOM_ALIAS"));
  });
});

test("CODE-005 拒绝展示层 Node 内置依赖", () => {
  withFixture((root) => {
    writeFixture(
      root,
      "src/pages/Home.tsx",
      "import {readFileSync} from \"node:fs\";\nexport default function Home() { return <p>{String(readFileSync)}</p>; }\n",
    );
    assert.ok(issueCodes(root).includes("MODULE_BOUNDARY_NODE_BUILTIN"));
  });
});

test("CODE-002 拒绝领域层 React/Docusaurus 依赖", () => {
  withFixture((root) => {
    writeFixture(
      root,
      "src/domain/example/rules.ts",
      "import type {ReactNode} from \"react\";\nexport type BadDomainType = ReactNode;\n",
    );
    assert.ok(issueCodes(root).includes("MODULE_BOUNDARY_DOMAIN_EXTERNAL"));
  });
});

test("D-067 拒绝未消费主/最低端点闭包的版本契约", () => {
  withFixture((root) => {
    writeFixture(root, ".nvmrc", "23.11.0\n");
    assert.ok(issueCodes(root).includes("MODULE_BOUNDARY_RUNTIME_CONTRACT"));
  });
});

test("CODE-005 拒绝无法静态证明的动态 import", () => {
  withFixture((root) => {
    writeFixture(
      root,
      "src/build/example/dynamic.ts",
      "const target = \"../../domain/example/index.js\";\nexport async function load() { return import(target); }\n",
    );
    assert.ok(issueCodes(root).includes("MODULE_BOUNDARY_DYNAMIC_IMPORT"));
  });
});
