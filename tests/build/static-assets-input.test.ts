import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {
  formatStaticAssetError,
  prepareStaticAssetPlan,
  StaticAssetError,
} from "../../src/build/static-assets/index.js";
import type {
  PrepareStaticAssetPlanInput,
  UnpublishedAssetSnapshotInput,
} from "../../src/build/static-assets/index.js";
import {validateProjectCatalog} from "../../src/domain/content/index.js";
import type {
  ProjectCatalog,
  ProjectCatalogInput,
  RegistryDocumentInput,
} from "../../src/domain/content/index.js";

const PRIVATE_DIAGNOSTIC = "private getter diagnostic must stay suppressed";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function createCatalog(): ProjectCatalog {
  const input: ProjectCatalogInput = {
    projects: {
      sourcePath: "docs/contracts/projects.json",
      value: {
        version: "0.3.0",
        kind: "axial_muse_projects",
        status: "active",
        owner: "AxialMuseWebsite",
        lifecycleStatusValues: ["active", "paused", "completed", "archived"],
        publicationStatusValues: ["draft", "planned", "published", "archived"],
        showcaseModes: ["repository", "repository-and-video"],
        projects: [{
          id: "input-boundary",
          title: "Input Boundary",
          slug: "input-boundary",
          navigationOrder: 1,
          summary: "A planned fixture with enough factual detail for stable input validation.",
          status: "active",
          publicationStatus: "planned",
          startedAt: "2026-01",
          updatedAt: "2026-07-01",
          repositoryUrl: "https://example.test/repositories/input-boundary",
          productionBranch: "main",
          showcaseMode: "repository",
          writingModules: [],
          source: ["https://example.test/evidence/input-boundary"],
        }],
      },
    },
    authors: {
      sourcePath: "docs/contracts/authors.json",
      value: {
        version: "0.1.0",
        kind: "axial_muse_authors",
        status: "active",
        owner: "AxialMuseWebsite",
        authors: {},
      },
    },
    topics: {
      sourcePath: "docs/contracts/topics.json",
      value: {
        version: "0.1.0",
        kind: "axial_muse_topics",
        status: "active",
        owner: "AxialMuseWebsite",
        topics: {},
      },
    },
    experiences: {
      sourcePath: "docs/contracts/project-experiences.json",
      value: {
        version: "0.1.0",
        kind: "axial_muse_project_experiences",
        status: "active",
        owner: "AxialMuseWebsite",
        canonicalDomain: "axialmuse.com",
        defaultDeliveryMode: "static",
        defaultIndexing: "noindex",
        statusValues: ["planned", "provisioning", "live", "paused", "retired"],
        deliveryModes: ["static"],
        reservedSubdomains: [
          "www", "api", "admin", "auth", "account", "assets", "cdn", "dev",
          "docs", "mail", "preview", "staging", "static", "status", "support",
        ],
        experiences: [],
      },
    },
    projectSources: [],
  };
  const result = validateProjectCatalog(input);
  if (!result.ok) assert.fail(`catalog fixture failed: ${JSON.stringify(result.issues)}`);
  return result.value;
}

const CATALOG = createCatalog();
const REGISTRY_VALUE = deepFreeze({
  version: "0.1.0",
  kind: "axial_muse_static_public_assets",
  status: "active",
  owner: "AxialMuseWebsite",
  roleValues: ["brand", "operational"],
  assets: [],
});

function registryDocument(): RegistryDocumentInput {
  return {
    sourcePath: "docs/contracts/static-public-assets.json",
    value: REGISTRY_VALUE,
  };
}

function validInput(
  repositoryRoot: string,
  unpublishedAssets?: readonly UnpublishedAssetSnapshotInput[],
): PrepareStaticAssetPlanInput {
  return {
    mode: "production",
    repositoryRoot,
    catalog: CATALOG,
    staticPublicRegistry: registryDocument(),
    ...(unpublishedAssets === undefined ? {} : {unpublishedAssets}),
  };
}

function validUnpublishedEntry(): UnpublishedAssetSnapshotInput {
  return {
    sourcePath: "site-content/writing/input-boundary/assets/private.bin",
    publicPath: "/writing/input-boundary/assets/private.bin",
    bytes: Uint8Array.from([0x01, 0x02, 0x03]),
  };
}

function withRepository(action: (repositoryRoot: string) => void): void {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "axial-muse-input-boundary-"));
  chmodSync(repositoryRoot, 0o700);
  try {
    action(repositoryRoot);
  } finally {
    rmSync(repositoryRoot, {recursive: true, force: true});
  }
}

function expectStaticAssetFailure(
  action: () => unknown,
  expectedCode: string,
): StaticAssetError {
  let captured: unknown;
  try {
    action();
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof StaticAssetError);
  assert.equal(captured.code, expectedCode);
  return captured;
}

function assertDiagnosticSuppressed(error: StaticAssetError): void {
  assert.doesNotMatch(error.message, /private getter diagnostic/u);
  assert.doesNotMatch(formatStaticAssetError(error), /private getter diagnostic/u);
}

test("I-12 prepareStaticAssetPlan 根输入只接受单次精确数据 descriptor 快照", async (t) => {
  await t.test("revoked Proxy", () => {
    const input = Proxy.revocable({}, {});
    input.revoke();
    const error = expectStaticAssetFailure(
      () => prepareStaticAssetPlan(
        input.proxy as unknown as PrepareStaticAssetPlanInput,
      ),
      "STATIC_ASSET_INPUT",
    );
    assert.equal(
      formatStaticAssetError(error),
      "[STATIC_ASSET_INPUT] (site-assets) 静态素材计划输入必须是精确的普通数据字段集合。",
    );
  });

  await t.test("throwing Proxy descriptor trap", () => {
    const input = new Proxy({}, {
      ownKeys() {
        throw new TypeError(PRIVATE_DIAGNOSTIC);
      },
    });
    const error = expectStaticAssetFailure(
      () => prepareStaticAssetPlan(
        input as unknown as PrepareStaticAssetPlanInput,
      ),
      "STATIC_ASSET_INPUT",
    );
    assertDiagnosticSuppressed(error);
  });

  await t.test("dynamic accessor is rejected without invocation", () => {
    let getterCalls = 0;
    const input = Object.defineProperty({}, "mode", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return getterCalls === 1 ? "production" : "preview";
      },
    });
    expectStaticAssetFailure(
      () => prepareStaticAssetPlan(
        input as unknown as PrepareStaticAssetPlanInput,
      ),
      "STATIC_ASSET_INPUT",
    );
    assert.equal(getterCalls, 0);
  });

  await t.test("unknown and symbol fields", () => withRepository((repositoryRoot) => {
    const unknownField = {...validInput(repositoryRoot), unexpected: true};
    expectStaticAssetFailure(
      () => prepareStaticAssetPlan(
        unknownField as unknown as PrepareStaticAssetPlanInput,
      ),
      "STATIC_ASSET_INPUT",
    );
    const symbolField = validInput(repositoryRoot) as PrepareStaticAssetPlanInput & {
      [key: symbol]: unknown;
    };
    Object.defineProperty(symbolField, Symbol("unexpected"), {
      enumerable: true,
      value: true,
    });
    expectStaticAssetFailure(
      () => prepareStaticAssetPlan(symbolField),
      "STATIC_ASSET_INPUT",
    );
  }));

  await t.test("Proxy get trap is not invoked after descriptor snapshot", () => (
    withRepository((repositoryRoot) => {
      let getterCalls = 0;
      const input = new Proxy(validInput(repositoryRoot), {
        get() {
          getterCalls += 1;
          throw new TypeError(PRIVATE_DIAGNOSTIC);
        },
      });
      const plan = prepareStaticAssetPlan(input);
      plan.dispose();
      assert.equal(getterCalls, 0);
    })
  ));
});

test("I-12 static-public registry wrapper 也只读取一次 data descriptor", async (t) => {
  await t.test("accessor wrapper is rejected without invocation", () => (
    withRepository((repositoryRoot) => {
      let getterCalls = 0;
      const registry = Object.defineProperty({value: REGISTRY_VALUE}, "sourcePath", {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new TypeError(PRIVATE_DIAGNOSTIC);
        },
      });
      const error = expectStaticAssetFailure(
        () => prepareStaticAssetPlan({
          ...validInput(repositoryRoot),
          staticPublicRegistry: registry as unknown as RegistryDocumentInput,
        }),
        "STATIC_ASSET_PUBLIC_REGISTRY",
      );
      assert.equal(getterCalls, 0);
      assertDiagnosticSuppressed(error);
    })
  ));

  await t.test("Proxy get trap is not invoked", () => withRepository((repositoryRoot) => {
    let getterCalls = 0;
    const registry = new Proxy(registryDocument(), {
      get() {
        getterCalls += 1;
        throw new TypeError(PRIVATE_DIAGNOSTIC);
      },
    });
    const plan = prepareStaticAssetPlan({
      ...validInput(repositoryRoot),
      staticPublicRegistry: registry,
    });
    plan.dispose();
    assert.equal(getterCalls, 0);
  }));
});

test("I-12 unpublishedAssets 拒绝 sparse/accessor/额外字段与 Proxy trap", async (t) => {
  const runFailure = (
    repositoryRoot: string,
    inputs: unknown,
  ): StaticAssetError => expectStaticAssetFailure(
    () => prepareStaticAssetPlan({
      ...validInput(repositoryRoot),
      unpublishedAssets: inputs as readonly UnpublishedAssetSnapshotInput[],
    }),
    "STATIC_ASSET_UNPUBLISHED_INPUT",
  );

  await t.test("revoked array Proxy", () => withRepository((repositoryRoot) => {
    const inputs = Proxy.revocable([], {});
    inputs.revoke();
    runFailure(repositoryRoot, inputs.proxy);
  }));

  await t.test("sparse array", () => withRepository((repositoryRoot) => {
    runFailure(repositoryRoot, new Array<unknown>(1));
  }));

  await t.test("array accessor is rejected without invocation", () => (
    withRepository((repositoryRoot) => {
      let getterCalls = 0;
      const inputs: unknown[] = [];
      Object.defineProperty(inputs, "0", {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new TypeError(PRIVATE_DIAGNOSTIC);
        },
      });
      const error = runFailure(repositoryRoot, inputs);
      assert.equal(getterCalls, 0);
      assertDiagnosticSuppressed(error);
    })
  ));

  await t.test("array extra field", () => withRepository((repositoryRoot) => {
    const inputs = [validUnpublishedEntry()];
    Object.defineProperty(inputs, "extra", {enumerable: true, value: true});
    runFailure(repositoryRoot, inputs);
  }));

  await t.test("revoked entry Proxy", () => withRepository((repositoryRoot) => {
    const entry = Proxy.revocable({}, {});
    entry.revoke();
    runFailure(repositoryRoot, [entry.proxy]);
  }));

  await t.test("entry accessor is rejected without invocation", () => (
    withRepository((repositoryRoot) => {
      let getterCalls = 0;
      const entry = {
        publicPath: "/writing/input-boundary/assets/private.bin",
        bytes: Uint8Array.from([0x01]),
      };
      Object.defineProperty(entry, "sourcePath", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return getterCalls === 1
            ? "site-content/writing/input-boundary/assets/private.bin"
            : "site-content/writing/changed/assets/private.bin";
        },
      });
      runFailure(repositoryRoot, [entry]);
      assert.equal(getterCalls, 0);
    })
  ));

  await t.test("entry unknown and symbol fields", () => (
    withRepository((repositoryRoot) => {
      runFailure(repositoryRoot, [{...validUnpublishedEntry(), unexpected: true}]);
      const entry = validUnpublishedEntry() as UnpublishedAssetSnapshotInput & {
        [key: symbol]: unknown;
      };
      Object.defineProperty(entry, Symbol("unexpected"), {
        enumerable: true,
        value: true,
      });
      runFailure(repositoryRoot, [entry]);
    })
  ));

  await t.test("entry Proxy get trap is not invoked", () => (
    withRepository((repositoryRoot) => {
      let getterCalls = 0;
      const entry = new Proxy(validUnpublishedEntry(), {
        get() {
          getterCalls += 1;
          throw new TypeError(PRIVATE_DIAGNOSTIC);
        },
      });
      const plan = prepareStaticAssetPlan(validInput(repositoryRoot, [entry]));
      plan.dispose();
      assert.equal(getterCalls, 0);
    })
  ));
});

test("I-12 unpublishedAssets 只接受项目或文章 entry 下的精确素材路径", async (t) => {
  await t.test("项目与文章正文素材统一进入 content-asset 排除集合", () => (
    withRepository((repositoryRoot) => {
      const projectAsset: UnpublishedAssetSnapshotInput = {
        sourcePath: "site-content/projects/input-boundary/assets/diagrams/private-state.png",
        publicPath: "/projects/input-boundary/assets/private-state.png",
        bytes: Uint8Array.from([0x04, 0x05, 0x06]),
      };
      const plan = prepareStaticAssetPlan(validInput(repositoryRoot, [
        validUnpublishedEntry(),
        projectAsset,
      ]));
      try {
        assert.deepEqual(plan.manifest.excludedFiles, [
          {
            kind: "content-asset",
            sourcePath: projectAsset.sourcePath,
            publicUrl: projectAsset.publicPath,
          },
          {
            kind: "content-asset",
            sourcePath: validUnpublishedEntry().sourcePath,
            publicUrl: validUnpublishedEntry().publicPath,
          },
        ]);
      } finally {
        plan.dispose();
      }
    })
  ));

  const invalidSourcePaths = [
    "site-content/project/input-boundary/assets/private.bin",
    "site-content/projects/input-boundary/asset/private.bin",
    "site-content/projects/input-boundary/assets",
    "site-content/projects/input-boundary/index/assets/private.bin",
    "site-content/projects/input-boundary/assets/private.bin/extra",
    "site-content/projects/Input-Boundary/assets/private.bin",
    "site-content/writing/input-boundary/assets/private",
  ];
  for (const [index, sourcePath] of invalidSourcePaths.entries()) {
    await t.test(`非法 sourcePath #${index + 1}`, () => (
      withRepository((repositoryRoot) => {
        expectStaticAssetFailure(
          () => prepareStaticAssetPlan(validInput(repositoryRoot, [{
            ...validUnpublishedEntry(),
            sourcePath,
          }])),
          "STATIC_ASSET_UNPUBLISHED_INPUT",
        );
      })
    ));
  }

  await t.test("重复 sourcePath 仍失败关闭", () => (
    withRepository((repositoryRoot) => {
      const entry = validUnpublishedEntry();
      expectStaticAssetFailure(
        () => prepareStaticAssetPlan(validInput(repositoryRoot, [
          entry,
          {
            ...entry,
            publicPath: "/assets/images/another-private-",
            bytes: Uint8Array.from([0x04, 0x05, 0x06]),
          },
        ])),
        "STATIC_ASSET_UNPUBLISHED_DUPLICATE",
      );
    })
  ));
});

test("I-12 prepareStaticAssetPlan 保留已有 StaticAssetError", () => (
  withRepository((repositoryRoot) => {
    const error = expectStaticAssetFailure(
      () => prepareStaticAssetPlan({
        ...validInput(repositoryRoot),
        mode: "invalid",
      } as unknown as PrepareStaticAssetPlanInput),
      "STATIC_ASSET_MODE",
    );
    assert.equal(error.message, "静态素材计划模式必须是 production 或 preview。");
  })
));
