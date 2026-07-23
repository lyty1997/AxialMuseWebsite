import assert from "node:assert/strict";
import test from "node:test";
import {
  createDocusaurusDocsAdapter,
  DocusaurusDocsAdapterError,
  type DocusaurusDocsAdapterSession,
} from "../../src/build/content/docs-adapter.js";
import {createClassicDerivedPreset} from "../../src/build/content/docusaurus-preset-factory.js";

const DOCS_PLUGIN_PATH = "/fixture/node_modules/@docusaurus/plugin-content-docs/lib/index.js";
const LOCAL_PRESET_PATH = "./src/build/content/docusaurus-preset.ts";
const OFFICIAL_LIFECYCLE_KEYS = [
  "configureWebpack",
  "contentLoaded",
  "extendCli",
  "getPathsToWatch",
  "getTranslationFiles",
  "loadContent",
  "name",
  "translateContent",
] as const;

interface OfficialFixture {
  readonly module: Parameters<typeof createDocusaurusDocsAdapter>[0];
  readonly validator: NonNullable<Parameters<typeof createDocusaurusDocsAdapter>[0]["validateOptions"]>;
  readonly plugin: Readonly<Record<string, unknown>>;
  readonly delegatedArgs: unknown[];
  readonly delegatedThis: unknown[];
}

function createLoadedContent({
  docs = [],
  drafts = [],
  noIndex = false,
}: Readonly<{
  docs?: unknown[];
  drafts?: unknown[];
  noIndex?: boolean;
}> = {}) {
  return {
    loadedVersions: [{
      versionName: "current",
      label: "Next",
      banner: null,
      badge: false,
      noIndex,
      className: "docs-version-current",
      path: "/",
      tagsPath: "/tags",
      editUrl: undefined,
      editUrlLocalized: undefined,
      isLast: true,
      routePriority: -1,
      sidebarFilePath: "/fixture/sidebars.ts",
      contentPath: "/fixture/site-content",
      contentPathLocalized: undefined,
      docs,
      drafts,
      sidebars: {},
    }],
  };
}

function createOfficialFixture(
  events: string[] = [],
  alterPlugin?: (plugin: Record<string, unknown>) => void,
): OfficialFixture {
  const delegatedArgs: unknown[] = [];
  const delegatedThis: unknown[] = [];
  const lifecycle = () => undefined;
  const plugin: Record<string, unknown> = {
    name: "docusaurus-plugin-content-docs",
    extendCli: lifecycle,
    getTranslationFiles: lifecycle,
    getPathsToWatch: lifecycle,
    loadContent: lifecycle,
    translateContent: lifecycle,
    async contentLoaded(this: unknown, args: unknown) {
      events.push("delegate");
      delegatedThis.push(this);
      delegatedArgs.push(args);
    },
    configureWebpack: lifecycle,
  };
  alterPlugin?.(plugin);
  const validator = (<T, U>({options}: Readonly<{options: T}>): U => options as unknown as U);
  async function pluginContentDocs(_context: unknown, _options: unknown) {
    events.push("official-constructor");
    return plugin;
  }
  Object.defineProperty(pluginContentDocs, "validateOptions", {
    enumerable: true,
    value: validator,
  });
  return {
    module: pluginContentDocs as Parameters<typeof createDocusaurusDocsAdapter>[0],
    validator,
    plugin,
    delegatedArgs,
    delegatedThis,
  };
}

function createSession(
  mode: "production" | "preview",
  snapshots: unknown[],
  assertCurrentDocsContent?: DocusaurusDocsAdapterSession["assertCurrentDocsContent"],
): DocusaurusDocsAdapterSession {
  return {
    mode,
    expectedVersion: Object.freeze({
      path: "/",
      contentPath: "/fixture/site-content",
      sidebarFilePath: "/fixture/sidebars.ts",
    }),
    assertCurrentDocsContent(snapshot) {
      snapshots.push(snapshot);
      return assertCurrentDocsContent?.(snapshot);
    },
  };
}

async function initializeAdapter(
  fixture: OfficialFixture,
  session: DocusaurusDocsAdapterSession,
  events: string[] = [],
) {
  const adapter = createDocusaurusDocsAdapter(fixture.module, () => {
    events.push("create-session");
    return session;
  });
  const plugin = await adapter({} as never, {id: "default"});
  assert.notEqual(plugin, null);
  return {adapter, plugin: plugin!};
}

async function runContentLoaded(
  plugin: Awaited<ReturnType<Parameters<typeof createDocusaurusDocsAdapter>[0]>>,
  content: unknown,
) {
  assert.notEqual(plugin, null);
  assert.equal(typeof plugin!.contentLoaded, "function");
  const actions = {
    addRoute() {},
    async createData() {
      return "/fixture/generated-data.json";
    },
    setGlobalData() {},
  };
  const args = {content, actions};
  await plugin!.contentLoaded!(args as never);
  return args;
}

function assertAdapterError(code: string) {
  return (error: unknown): boolean => {
    assert.equal(error instanceof DocusaurusDocsAdapterError, true);
    assert.equal((error as DocusaurusDocsAdapterError).code, code);
    return true;
  };
}

function assertShallowDescriptorProjection(
  original: object,
  projected: object,
  replacedKey: PropertyKey,
): void {
  const originalDescriptors = Object.getOwnPropertyDescriptors(original);
  const projectedDescriptors = Object.getOwnPropertyDescriptors(projected);
  assert.deepEqual(
    Reflect.ownKeys(projectedDescriptors),
    Reflect.ownKeys(originalDescriptors),
  );
  for (const key of Reflect.ownKeys(originalDescriptors)) {
    const before = Reflect.get(originalDescriptors, key) as PropertyDescriptor;
    const after = Reflect.get(projectedDescriptors, key) as PropertyDescriptor;
    assert.equal(after.configurable, before.configurable);
    assert.equal(after.enumerable, before.enumerable);
    assert.equal("value" in after, "value" in before);
    if ("value" in before && "value" in after) {
      assert.equal(after.writable, before.writable);
      if (key !== replacedKey) assert.equal(after.value, before.value);
    } else {
      assert.equal(after.get, before.get);
      assert.equal(after.set, before.set);
    }
  }
}

function runPreset(
  preset: ReturnType<typeof createClassicDerivedPreset>,
  options: unknown,
  siteConfigOverrides: Readonly<Record<string, unknown>> = {},
) {
  return preset({
    siteConfig: {
      plugins: [],
      themes: [],
      presets: [[LOCAL_PRESET_PATH, options]],
      ...siteConfigOverrides,
    },
  } as never, options);
}

test("E-016 production 零公开 docs 校验对应关系后跳过官方 contentLoaded", async () => {
  const events: string[] = [];
  const snapshots: unknown[] = [];
  const fixture = createOfficialFixture(events);
  const {adapter, plugin} = await initializeAdapter(
    fixture,
    createSession("production", snapshots),
    events,
  );
  const draft = {source: "@site/site-content/projects/planned/index.md"};
  await runContentLoaded(plugin, createLoadedContent({drafts: [draft]}));

  assert.deepEqual(events, ["create-session", "official-constructor"]);
  assert.equal(fixture.delegatedArgs.length, 0);
  assert.equal(snapshots.length, 1);
  assert.deepEqual(
    (snapshots[0] as {docs: readonly unknown[]; drafts: readonly unknown[]}).docs,
    [],
  );
  assert.deepEqual(
    (snapshots[0] as {docs: readonly unknown[]; drafts: readonly unknown[]}).drafts,
    [draft],
  );
  assert.equal(Object.isFrozen(
    (snapshots[0] as {docs: readonly unknown[]}).docs,
  ), true);
  assert.equal(adapter.validateOptions, fixture.validator);
});

test("E-016 production 仅向官方 lifecycle 投影公开 docs 并清空 draftIds 来源", async () => {
  const snapshots: unknown[] = [];
  const fixture = createOfficialFixture();
  const {plugin} = await initializeAdapter(
    fixture,
    createSession("production", snapshots),
  );
  const publicDoc = {
    id: "writing/public",
    source: "@site/site-content/writing/public/index.md",
    metadata: {owner: "article", provenance: ["validated-source"]},
  };
  const draft = {
    id: "projects/planned",
    source: "@site/site-content/projects/planned/index.md",
  };
  const content = createLoadedContent({docs: [publicDoc], drafts: [draft]});
  const originalVersion = content.loadedVersions[0]!;
  const originalLoadedVersions = content.loadedVersions;
  const originalDocs = originalVersion.docs;
  const originalDrafts = originalVersion.drafts;
  const contentDescriptors = Object.getOwnPropertyDescriptors(content);
  const versionDescriptors = Object.getOwnPropertyDescriptors(originalVersion);
  const docsDescriptors = Object.getOwnPropertyDescriptors(originalDocs);
  const draftsDescriptors = Object.getOwnPropertyDescriptors(originalDrafts);
  const args = await runContentLoaded(plugin, content);

  assert.equal(fixture.delegatedArgs.length, 1);
  assert.notEqual(fixture.delegatedArgs[0], args);
  assert.equal(fixture.delegatedThis[0], plugin);
  const delegated = fixture.delegatedArgs[0] as {
    actions: unknown;
    content: ReturnType<typeof createLoadedContent>;
  };
  assert.equal(delegated.actions, args.actions);
  assert.notEqual(delegated.content, content);
  assert.notEqual(delegated.content.loadedVersions, originalLoadedVersions);
  const projectedVersion = delegated.content.loadedVersions[0]!;
  assert.notEqual(projectedVersion, originalVersion);
  assert.equal(projectedVersion.docs, originalDocs);
  assert.equal(projectedVersion.docs[0], publicDoc);
  assert.deepEqual(projectedVersion.docs, [publicDoc]);
  assert.notEqual(projectedVersion.drafts, originalDrafts);
  assert.deepEqual(projectedVersion.drafts, []);
  assertShallowDescriptorProjection(args, delegated, "content");
  assertShallowDescriptorProjection(content, delegated.content, "loadedVersions");
  assertShallowDescriptorProjection(
    originalLoadedVersions,
    delegated.content.loadedVersions,
    "0",
  );
  assertShallowDescriptorProjection(originalVersion, projectedVersion, "drafts");

  assert.equal(content.loadedVersions, originalLoadedVersions);
  assert.equal(content.loadedVersions[0], originalVersion);
  assert.equal(originalVersion.docs, originalDocs);
  assert.equal(originalVersion.drafts, originalDrafts);
  assert.deepEqual(originalDocs, [publicDoc]);
  assert.deepEqual(originalDrafts, [draft]);
  assert.deepEqual(Object.getOwnPropertyDescriptors(content), contentDescriptors);
  assert.deepEqual(Object.getOwnPropertyDescriptors(originalVersion), versionDescriptors);
  assert.deepEqual(Object.getOwnPropertyDescriptors(originalDocs), docsDescriptors);
  assert.deepEqual(Object.getOwnPropertyDescriptors(originalDrafts), draftsDescriptors);
  assert.equal(snapshots.length, 2);
  for (const key of OFFICIAL_LIFECYCLE_KEYS) {
    if (key !== "contentLoaded") {
      assert.equal(
        (plugin as unknown as Record<string, unknown>)[key],
        fixture.plugin[key],
      );
    }
  }
});

test("E-016 preview 保持原始 args、content、actions 与 owner identity", async () => {
  const snapshots: unknown[] = [];
  const fixture = createOfficialFixture();
  const {plugin} = await initializeAdapter(
    fixture,
    createSession("preview", snapshots),
  );
  const doc = {
    id: "projects/planned",
    source: "@site/site-content/projects/planned/index.md",
  };
  const content = createLoadedContent({docs: [doc], noIndex: true});
  const args = await runContentLoaded(plugin, content);

  assert.equal(fixture.delegatedArgs.length, 1);
  assert.equal(fixture.delegatedArgs[0], args);
  assert.equal(fixture.delegatedThis[0], plugin);
  assert.equal(
    (fixture.delegatedArgs[0] as {content: unknown}).content,
    content,
  );
  assert.equal(
    (fixture.delegatedArgs[0] as {actions: unknown}).actions,
    args.actions,
  );
  assert.equal(snapshots.length, 2);
});

test("E-016 官方 lifecycle 修改 production clone 不得污染原始 content 图", async () => {
  let receivedActions: unknown;
  const fixture = createOfficialFixture([], (officialPlugin) => {
    officialPlugin.contentLoaded = function contentLoaded(args: unknown) {
      const delegated = args as {
        actions: unknown;
        content: ReturnType<typeof createLoadedContent>;
      };
      receivedActions = delegated.actions;
      const version = delegated.content.loadedVersions[0]!;
      version.docs = [{source: "@site/injected.md"}];
      version.drafts.push({source: "@site/injected-draft.md"});
      version.sidebars = {injected: []};
    };
  });
  const {plugin} = await initializeAdapter(
    fixture,
    createSession("production", []),
  );
  const publicDoc = {
    source: "@site/site-content/writing/public/index.md",
    metadata: {owner: "article"},
  };
  const draft = {source: "@site/site-content/projects/planned/index.md"};
  const content = createLoadedContent({docs: [publicDoc], drafts: [draft]});
  const actions = {
    addRoute() {},
    async createData() { return "/fixture/data.json"; },
    setGlobalData() {},
  };

  await assert.rejects(
    async () => { await plugin!.contentLoaded!({content, actions} as never); },
    assertAdapterError("DOCS_ADAPTER_CONTENT_MUTATION"),
  );
  assert.equal(receivedActions, actions);
  assert.deepEqual(content.loadedVersions[0]!.docs, [publicDoc]);
  assert.deepEqual(content.loadedVersions[0]!.drafts, [draft]);
  assert.deepEqual(publicDoc, {
    source: "@site/site-content/writing/public/index.md",
    metadata: {owner: "article"},
  });
  assert.deepEqual(content.loadedVersions[0]!.sidebars, {});
});

test("E-016 projection 对 getter、proxy 与受控结构漂移全部失败关闭", async () => {
  {
    const fixture = createOfficialFixture();
    const {plugin} = await initializeAdapter(
      fixture,
      createSession("production", []),
    );
    let getterCalls = 0;
    const args = Object.defineProperties({}, {
      actions: {
        enumerable: true,
        value: {
          addRoute() {},
          async createData() { return "/fixture/data.json"; },
          setGlobalData() {},
        },
      },
      content: {
        enumerable: true,
        get() {
          getterCalls += 1;
          return createLoadedContent();
        },
      },
    });
    await assert.rejects(
      async () => { await plugin!.contentLoaded!(args as never); },
      assertAdapterError("DOCS_ADAPTER_CONTENT_SHAPE"),
    );
    assert.equal(getterCalls, 0);
    assert.equal(fixture.delegatedArgs.length, 0);
  }
  {
    const fixture = createOfficialFixture();
    const {plugin} = await initializeAdapter(
      fixture,
      createSession("production", []),
    );
    const proxy = new Proxy(createLoadedContent(), {
      ownKeys() {
        throw new Error("proxy ownKeys trap");
      },
    });
    await assert.rejects(
      () => runContentLoaded(plugin, proxy),
      assertAdapterError("DOCS_ADAPTER_CONTENT_SHAPE"),
    );
    assert.equal(fixture.delegatedArgs.length, 0);
  }
  {
    const fixture = createOfficialFixture();
    const {plugin} = await initializeAdapter(
      fixture,
      createSession("production", []),
    );
    const content = createLoadedContent({
      docs: [{source: "@site/site-content/writing/public/index.md"}],
    });
    let getterCalls = 0;
    Object.defineProperty(content.loadedVersions[0]!, "drafts", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [];
      },
    });
    await assert.rejects(
      () => runContentLoaded(plugin, content),
      assertAdapterError("DOCS_ADAPTER_CONTENT_SHAPE"),
    );
    assert.equal(getterCalls, 0);
    assert.equal(fixture.delegatedArgs.length, 0);
  }
  {
    const fixture = createOfficialFixture();
    const {plugin} = await initializeAdapter(
      fixture,
      createSession("production", []),
    );
    const content = createLoadedContent({
      docs: [{source: "@site/site-content/writing/public/index.md"}],
    });
    const actions = {
      addRoute() {},
      async createData() { return "/fixture/data.json"; },
      setGlobalData() {},
      unexpected: true,
    };
    await assert.rejects(
      async () => { await plugin!.contentLoaded!({content, actions} as never); },
      assertAdapterError("DOCS_ADAPTER_CONTENT_SHAPE"),
    );
    assert.equal(fixture.delegatedArgs.length, 0);
  }
});

test("E-016 session 在官方构造器读取 markdown 配置前创建", async () => {
  const events: string[] = [];
  const fixture = createOfficialFixture(events);
  await initializeAdapter(fixture, createSession("production", []), events);
  assert.deepEqual(events, ["create-session", "official-constructor"]);
});

test("E-016 current-only unversioned 结构漂移全部失败关闭", async () => {
  const cases: Array<readonly [string, (content: ReturnType<typeof createLoadedContent>) => void]> = [
    ["无 version", (content) => { content.loadedVersions = []; }],
    ["versioned", (content) => { content.loadedVersions[0]!.versionName = "1.0.0"; }],
    ["localized", (content) => {
      (content.loadedVersions[0] as unknown as Record<string, unknown>)
        .contentPathLocalized = "/fixture/i18n/zh-CN/docs";
    }],
    ["附加字段", (content) => {
      (content.loadedVersions[0] as unknown as Record<string, unknown>).unexpected = true;
    }],
  ];
  for (const [label, mutate] of cases) {
    const fixture = createOfficialFixture();
    const {plugin} = await initializeAdapter(
      fixture,
      createSession("production", []),
    );
    const content = createLoadedContent();
    mutate(content);
    await assert.rejects(
      () => runContentLoaded(plugin, content),
      assertAdapterError("DOCS_ADAPTER_CONTENT_SHAPE"),
      label,
    );
    assert.equal(fixture.delegatedArgs.length, 0, label);
  }
});

test("E-016 current version 精确绑定根路由、唯一内容物理根与根侧栏", async () => {
  for (const [label, field, value] of [
    ["第二 route root", "path", "/docs/"],
    ["第二内容根", "contentPath", "/fixture/other-content"],
    ["第二侧栏", "sidebarFilePath", "/fixture/other-sidebars.ts"],
  ] as const) {
    const fixture = createOfficialFixture();
    const {plugin} = await initializeAdapter(
      fixture,
      createSession("production", []),
    );
    const content = createLoadedContent();
    (content.loadedVersions[0] as unknown as Record<string, unknown>)[field] = value;
    await assert.rejects(
      () => runContentLoaded(plugin, content),
      assertAdapterError("DOCS_ADAPTER_VERSION_IDENTITY"),
      label,
    );
    assert.equal(fixture.delegatedArgs.length, 0, label);
  }
});

test("E-016 session 对应校验失败或修改框架集合时不得委托", async () => {
  {
    const fixture = createOfficialFixture();
    const expected = new Error("fixture correspondence failure");
    const session = createSession("production", [], () => {
      throw expected;
    });
    const {plugin} = await initializeAdapter(fixture, session);
    await assert.rejects(
      () => runContentLoaded(plugin, createLoadedContent()),
      (error) => error === expected,
    );
    assert.equal(fixture.delegatedArgs.length, 0);
  }
  {
    const fixture = createOfficialFixture();
    const content = createLoadedContent({docs: [{source: "@site/public.md"}]});
    const session = createSession("production", [], (snapshot) => {
      (snapshot.version as {docs: unknown[]}).docs.push({source: "@site/injected.md"});
    });
    const {plugin} = await initializeAdapter(fixture, session);
    await assert.rejects(
      () => runContentLoaded(plugin, content),
      assertAdapterError("DOCS_ADAPTER_CONTENT_MUTATION"),
    );
    assert.equal(fixture.delegatedArgs.length, 0);
  }
  {
    const fixture = createOfficialFixture();
    const doc = {source: "@site/public.md", title: "原标题"};
    const content = createLoadedContent({docs: [doc]});
    const session = createSession("production", [], (snapshot) => {
      (snapshot.docs[0] as {title: string}).title = "被修改";
    });
    const {plugin} = await initializeAdapter(fixture, session);
    await assert.rejects(
      () => runContentLoaded(plugin, content),
      assertAdapterError("DOCS_ADAPTER_CONTENT_MUTATION"),
    );
    assert.equal(fixture.delegatedArgs.length, 0);
  }
});

test("E-016 固定官方 lifecycle 或 validator 漂移时拒绝包装", async () => {
  const missingLifecycle = createOfficialFixture([], (plugin) => {
    delete plugin.translateContent;
  });
  const {plugin} = await initializeAdapter(
    missingLifecycle,
    createSession("production", []),
  ).catch((error: unknown) => {
    assertAdapterError("DOCS_ADAPTER_PLUGIN_INSTANCE")(error);
    return {plugin: null};
  });
  assert.equal(plugin, null);

  async function pluginContentDocs() {
    return null;
  }
  assert.throws(
    () => createDocusaurusDocsAdapter(
      pluginContentDocs as Parameters<typeof createDocusaurusDocsAdapter>[0],
      () => createSession("production", []),
    ),
    assertAdapterError("DOCS_ADAPTER_PLUGIN_MODULE"),
  );
});

function createPresetHarness(sidebars: unknown = {
  projectsSidebar: [{type: "autogenerated", dirName: "projects"}],
  writingSidebar: [{type: "autogenerated", dirName: "writing"}],
}) {
  const events: string[] = [];
  const calls: Array<Readonly<Record<string, unknown>>> = [];
  const docsPlugin = createOfficialFixture(events);
  const session = Object.freeze({
    docsAdapterSession: createSession("production", []),
  });
  const theme = ["/fixture/theme.js", {customCss: "fixture"}];
  const before = ["/fixture/css.js", {layers: true}];
  const after = ["/fixture/blog.js", {routeBasePath: "writing"}];
  const contentDataPlugin = function axialMuseContentDataPlugin() {
    return {name: "axial-muse-content-data"};
  };
  const projectPreviewRemarkPlugin = function projectPreviewRemarkPlugin() {
    return () => undefined;
  };
  const preset = createClassicDerivedPreset({
    presetClassic(_context, options = {}) {
      calls.push(options as unknown as Readonly<Record<string, unknown>>);
      const docsOptions = (options as unknown as {docs: Record<string, unknown>}).docs;
      return {
        themes: [theme as never],
        plugins: [
          before as never,
          [DOCS_PLUGIN_PATH, docsOptions],
          after as never,
        ],
      };
    },
    async loadFreshModule(path) {
      events.push(`load:${path}`);
      return docsPlugin.module;
    },
    sidebars,
    async createContentBuildSession() {
      events.push("create-build-session");
      return session as never;
    },
    sessionSidebarItemsGenerator(received) {
      assert.equal(received, session);
      return function sidebarItemsGenerator() {
        return [];
      };
    },
    sessionProjectPreviewRemarkPlugin(received) {
      assert.equal(received, session);
      return projectPreviewRemarkPlugin;
    },
    createContentDataPlugin(received) {
      assert.equal(received, session);
      return contentDataPlugin as never;
    },
  });
  return {
    after,
    before,
    calls,
    contentDataPlugin,
    docsPlugin,
    events,
    preset,
    projectPreviewRemarkPlugin,
    session,
    sidebars,
    theme,
  };
}

test("E-016 classic-derived preset 构造唯一 docs options、替换官方插件并追加数据插件", async () => {
  const harness = createPresetHarness();
  const options = {
    blog: false,
    sitemap: {},
    theme: {},
  };
  const result = await runPreset(harness.preset, options);
  assert.deepEqual(harness.events, [
    "create-build-session",
    `load:${DOCS_PLUGIN_PATH}`,
  ]);
  assert.equal(harness.calls.length, 1);
  const docsOptions = harness.calls[0]!.docs as Readonly<Record<string, unknown>>;
  assert.deepEqual(Object.keys(docsOptions).sort(), [
    "includeCurrentVersion",
    "onlyIncludeVersions",
    "path",
    "remarkPlugins",
    "routeBasePath",
    "sidebarItemsGenerator",
    "sidebarPath",
    "tags",
  ]);
  assert.equal(docsOptions.path, "site-content");
  assert.equal(docsOptions.routeBasePath, "/");
  assert.equal(docsOptions.sidebarPath, "./sidebars.ts");
  assert.equal(docsOptions.includeCurrentVersion, true);
  assert.deepEqual(docsOptions.onlyIncludeVersions, ["current"]);
  assert.equal(docsOptions.tags, false);
  assert.equal(typeof docsOptions.sidebarItemsGenerator, "function");
  assert.equal(Object.isFrozen(docsOptions.remarkPlugins), true);
  assert.deepEqual(docsOptions.remarkPlugins, [harness.projectPreviewRemarkPlugin]);
  assert.equal(result.themes![0], harness.theme);
  assert.equal(result.plugins!.length, 4);
  assert.equal(result.plugins![0], harness.before);
  assert.equal(result.plugins![2], harness.after);
  assert.equal(result.plugins![3], harness.contentDataPlugin);
  const adaptedTuple = result.plugins![1];
  assert.equal(Array.isArray(adaptedTuple), true);
  const tuple = adaptedTuple as [unknown, unknown];
  assert.equal(tuple[1], docsOptions);
  assert.equal(typeof tuple[0], "function");
  assert.equal(
    (tuple[0] as typeof harness.docsPlugin.module).validateOptions,
    harness.docsPlugin.validator,
  );
});

test("E-016 preset 每次调用创建新 session、重新装载模块且不跨构建缓存", async () => {
  const harness = createPresetHarness();
  const first = await runPreset(harness.preset, {blog: false});
  const second = await runPreset(harness.preset, {blog: false});
  assert.equal(harness.events.filter((event) => event === "create-build-session").length, 2);
  assert.equal(harness.events.filter((event) => event.startsWith("load:")).length, 2);
  assert.notEqual(first.plugins![1], second.plugins![1]);
  assert.notEqual(
    (first.plugins![1] as [unknown, unknown])[0],
    (second.plugins![1] as [unknown, unknown])[0],
  );
  assert.notEqual(harness.calls[0]!.docs, harness.calls[1]!.docs);
});

test("CODE-013 preset 安全解包 Jiti self-default getter 并绑定真实 sidebar config", async () => {
  const sidebars: Record<string, unknown> = {
    projectsSidebar: [{type: "autogenerated", dirName: "projects"}],
    writingSidebar: [{type: "autogenerated", dirName: "writing"}],
  };
  let getterCalls = 0;
  Object.defineProperty(sidebars, "default", {
    configurable: false,
    enumerable: false,
    get() {
      getterCalls += 1;
      return sidebars;
    },
  });
  const harness = createPresetHarness(sidebars);
  await runPreset(harness.preset, {blog: false});
  assert.equal(getterCalls, 6);
});

test("CODE-013 preset 拒绝不稳定的 sidebar default getter", () => {
  const first = {
    projectsSidebar: [{type: "autogenerated", dirName: "projects"}],
    writingSidebar: [{type: "autogenerated", dirName: "writing"}],
  };
  const second = {
    projectsSidebar: first.projectsSidebar,
    writingSidebar: first.writingSidebar,
  };
  let calls = 0;
  const wrapper = Object.defineProperty({}, "default", {
    configurable: false,
    enumerable: false,
    get() {
      calls += 1;
      return calls % 2 === 1 ? first : second;
    },
  });
  assert.throws(
    () => createPresetHarness(wrapper),
    assertAdapterError("DOCS_PRESET_SIDEBAR_CONFIG"),
  );
});

test("E-016 preset 拒绝 caller docs、重复候选与插件路径漂移", async () => {
  const harness = createPresetHarness();
  await assert.rejects(
    () => runPreset(harness.preset, {docs: false}),
    assertAdapterError("DOCS_PRESET_OPTIONS"),
  );
  const accessorOptions = Object.defineProperty({}, "blog", {
    enumerable: true,
    get: () => false,
  });
  await assert.rejects(
    () => runPreset(harness.preset, accessorOptions),
    assertAdapterError("DOCS_PRESET_OPTIONS"),
  );

  for (const [label, pluginPath, duplicate, expectedCode] of [
    ["重复", DOCS_PLUGIN_PATH, true, "DOCS_PRESET_DOCS_CONFIG"],
    ["路径", "/fixture/other-plugin.js", false, "DOCS_PRESET_PLUGIN_PATH"],
  ] as const) {
    const docsPlugin = createOfficialFixture();
    const preset = createClassicDerivedPreset({
      presetClassic(_context, options = {}) {
        const docsOptions = (
          options as unknown as {docs: Record<string, unknown>}
        ).docs;
        const candidate: [string, Record<string, unknown>] = [pluginPath, docsOptions];
        return {
          themes: [],
          plugins: duplicate ? [candidate, [pluginPath, docsOptions]] : [candidate],
        };
      },
      loadFreshModule: async () => docsPlugin.module,
      sidebars: {
        projectsSidebar: [{type: "autogenerated", dirName: "projects"}],
        writingSidebar: [{type: "autogenerated", dirName: "writing"}],
      },
      createContentBuildSession: async () => ({
        docsAdapterSession: createSession("production", []),
      } as never),
      sessionSidebarItemsGenerator: () => () => [],
      sessionProjectPreviewRemarkPlugin: () => () => () => undefined,
      createContentDataPlugin: () => (() => ({name: "data"})) as never,
    });
    await assert.rejects(
      () => runPreset(preset, {}),
      assertAdapterError(expectedCode),
      label,
    );
  }
});

test("CODE-013 preset 运行时拒绝手写 doc ID 或额外 sidebar key", () => {
  for (const [label, sidebars] of [
    ["手写 doc", {
      projectsSidebar: [{type: "doc", id: "projects/manual"}],
      writingSidebar: [{type: "autogenerated", dirName: "writing"}],
    }],
    ["额外 key", {
      projectsSidebar: [{type: "autogenerated", dirName: "projects"}],
      writingSidebar: [{type: "autogenerated", dirName: "writing"}],
      extraSidebar: [{type: "autogenerated", dirName: "writing"}],
    }],
  ] as const) {
    assert.throws(
      () => createClassicDerivedPreset({
        presetClassic: () => ({plugins: [], themes: []}),
        loadFreshModule: async () => () => ({name: "fixture"}),
        sidebars,
        createContentBuildSession: async () => ({}) as never,
        sessionSidebarItemsGenerator: () => () => [],
        sessionProjectPreviewRemarkPlugin: () => () => () => undefined,
        createContentDataPlugin: () => (() => ({name: "fixture"})) as never,
      }),
      assertAdapterError("DOCS_PRESET_SIDEBAR_CONFIG"),
      label,
    );
  }
});

test("E-016 preset 拒绝 docs options 漂移、第二主预览投影与额外 docs tuple", async () => {
  for (const [label, mutate] of [
    ["原地修改", (plugins: unknown[], docsOptions: Record<string, unknown>) => {
      docsOptions.path = "other-content";
      plugins.push([DOCS_PLUGIN_PATH, docsOptions]);
    }],
    ["额外实例", (plugins: unknown[], docsOptions: Record<string, unknown>) => {
      plugins.push([DOCS_PLUGIN_PATH, {...docsOptions}]);
    }],
    ["替换主预览插件", (_plugins: unknown[], docsOptions: Record<string, unknown>) => {
      docsOptions.remarkPlugins = [() => () => undefined];
    }],
  ] as const) {
    const docsPlugin = createOfficialFixture();
    const preset = createClassicDerivedPreset({
      presetClassic(_context, options = {}) {
        const docsOptions = (
          options as unknown as {docs: Record<string, unknown>}
        ).docs;
        const plugins: unknown[] = [[DOCS_PLUGIN_PATH, docsOptions]];
        mutate(plugins, docsOptions);
        return {themes: [], plugins: plugins as never[]};
      },
      loadFreshModule: async () => docsPlugin.module,
      sidebars: {
        projectsSidebar: [{type: "autogenerated", dirName: "projects"}],
        writingSidebar: [{type: "autogenerated", dirName: "writing"}],
      },
      createContentBuildSession: async () => ({
        docsAdapterSession: createSession("production", []),
      } as never),
      sessionSidebarItemsGenerator: () => () => [],
      sessionProjectPreviewRemarkPlugin: () => () => () => undefined,
      createContentDataPlugin: () => (() => ({name: "data"})) as never,
    });
    await assert.rejects(
      () => runPreset(preset, {}),
      assertAdapterError("DOCS_PRESET_DOCS_CONFIG"),
      label,
    );
  }
});

test("E-016 根配置拒绝额外 official docs plugin 或第二 docs preset", async () => {
  const harness = createPresetHarness();
  for (const [label, overrides] of [
    ["额外 official docs plugin", {
      plugins: [[DOCS_PLUGIN_PATH, {path: "other-content"}]],
    }],
    ["第二 docs preset", {
      presets: [
        [LOCAL_PRESET_PATH, {}],
        ["@docusaurus/preset-classic", {docs: {path: "other-content"}}],
      ],
    }],
  ] as const) {
    await assert.rejects(
      () => runPreset(harness.preset, {}, overrides),
      assertAdapterError("DOCS_PRESET_SITE_CONFIG"),
      label,
    );
    assert.equal(harness.events.includes("create-build-session"), false, label);
  }
});
