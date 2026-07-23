import type {Options as ClassicPresetOptions} from "@docusaurus/preset-classic";
import type {
  LoadContext,
  PluginConfig,
  PluginModule,
  Preset,
} from "@docusaurus/types";
import {isAbsolute} from "node:path";
import {
  createDocusaurusDocsAdapter,
  DocusaurusDocsAdapterError,
} from "./docs-adapter.js";
import type {ContentBuildSession} from "./session.js";

const DOCS_PLUGIN_PATH_SUFFIX = "/node_modules/@docusaurus/plugin-content-docs/lib/index.js";
const LOCAL_PRESET_PATH = "./src/build/content/docusaurus-preset.ts";

type ClassicPreset = (
  context: LoadContext,
  options?: ClassicPresetOptions,
) => Preset;

type FreshModuleLoader = (modulePath: string) => Promise<unknown>;

export type ClassicDerivedPreset = (
  context: LoadContext,
  options: unknown,
) => Promise<Preset>;

export interface ClassicDerivedPresetDependencies {
  readonly presetClassic: ClassicPreset;
  readonly loadFreshModule: FreshModuleLoader;
  readonly sidebars: unknown;
  readonly createContentBuildSession: (
    context: LoadContext,
  ) => Promise<ContentBuildSession>;
  readonly sessionSidebarItemsGenerator: (
    session: ContentBuildSession,
  ) => unknown;
  readonly sessionProjectPreviewRemarkPlugin: (
    session: ContentBuildSession,
  ) => unknown;
  readonly createContentDataPlugin: (
    session: ContentBuildSession,
  ) => PluginModule<undefined>;
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new DocusaurusDocsAdapterError(
    code,
    message,
    cause === undefined ? {} : {cause},
  );
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function readPlainDataDescriptors(
  value: unknown,
  label: string,
): PropertyDescriptorMap {
  if (!isObject(value) || Array.isArray(value)) {
    return fail("DOCS_PRESET_OPTIONS", `${label} 必须是普通 object。`);
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    return fail("DOCS_PRESET_OPTIONS", `${label} 无法安全读取。`, error);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return fail("DOCS_PRESET_OPTIONS", `${label} 的 prototype 非法。`);
  }
  if (Object.getOwnPropertySymbols(descriptors).length !== 0) {
    return fail("DOCS_PRESET_OPTIONS", `${label} 不得包含 symbol 字段。`);
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) {
      return fail("DOCS_PRESET_OPTIONS", `${label}.${key} 必须是 data property。`);
    }
  }
  return descriptors;
}

function readClassicOptions(value: unknown): ClassicPresetOptions {
  const descriptors = readPlainDataDescriptors(value, "classic-derived preset options");
  if (descriptors.docs !== undefined) {
    return fail("DOCS_PRESET_OPTIONS", "docs options 只能由本地 preset 构造。");
  }
  const classicOptions: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    classicOptions[key] = descriptor.value;
  }
  return classicOptions as ClassicPresetOptions;
}

function snapshotDenseArray(value: unknown, label: string): readonly unknown[] {
  let isArray: boolean;
  let prototype: object | null;
  try {
    isArray = Array.isArray(value);
    prototype = isArray ? Object.getPrototypeOf(value) : null;
  } catch (error) {
    return fail("DOCS_PRESET_SHAPE", `${label} 无法安全读取 Array 结构。`, error);
  }
  if (!isArray || prototype !== Array.prototype) {
    return fail("DOCS_PRESET_SHAPE", `${label} 必须是普通 Array。`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(descriptors).length !== 0) {
    return fail("DOCS_PRESET_SHAPE", `${label} 不得包含 symbol 字段。`);
  }
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    return fail("DOCS_PRESET_SHAPE", `${label}.length 结构非法。`);
  }
  const expectedKeys = Array.from(
    {length: lengthDescriptor.value as number},
    (_, index) => String(index),
  );
  const actualKeys = Object.keys(descriptors)
    .filter((key) => key !== "length")
    .sort((left, right) => Number(left) - Number(right));
  if (
    expectedKeys.length !== actualKeys.length
    || expectedKeys.some((key, index) => key !== actualKeys[index])
  ) {
    return fail("DOCS_PRESET_SHAPE", `${label} 必须是无附加字段的稠密 Array。`);
  }
  return expectedKeys.map((key) => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      return fail("DOCS_PRESET_SHAPE", `${label}[${key}] 必须是 data property。`);
    }
    return descriptor.value;
  });
}

function inspectClassicPreset(value: unknown): {
  readonly preset: Preset;
  readonly plugins: readonly PluginConfig[];
} {
  const descriptors = readPlainDataDescriptors(value, "presetClassic 返回值");
  const keys = Object.keys(descriptors).sort();
  if (keys.length !== 2 || keys[0] !== "plugins" || keys[1] !== "themes") {
    return fail("DOCS_PRESET_SHAPE", "presetClassic 返回值字段集合发生漂移。");
  }
  const plugins = snapshotDenseArray(descriptors.plugins?.value, "presetClassic.plugins");
  snapshotDenseArray(descriptors.themes?.value, "presetClassic.themes");
  return {
    preset: value as Preset,
    plugins: plugins as readonly PluginConfig[],
  };
}

function assertExactDocsPluginPath(value: string): void {
  const normalized = value.replaceAll("\\", "/");
  if (!isAbsolute(value) || !normalized.endsWith(DOCS_PLUGIN_PATH_SUFFIX)) {
    return fail(
      "DOCS_PRESET_PLUGIN_PATH",
      "presetClassic 返回的 docs plugin 入口路径发生漂移。",
    );
  }
}

function assertExactAutogeneratedSlice(
  value: unknown,
  expectedDirectory: "projects" | "writing",
  label: string,
): void {
  const items = snapshotDenseArray(value, label);
  if (items.length !== 1) {
    return fail(
      "DOCS_PRESET_SIDEBAR_CONFIG",
      `${label} 必须精确包含一个 autogenerated slice。`,
    );
  }
  const descriptors = readPlainDataDescriptors(items[0], `${label}[0]`);
  const keys = Object.keys(descriptors).sort();
  if (
    keys.length !== 2
    || keys[0] !== "dirName"
    || keys[1] !== "type"
    || descriptors.type?.value !== "autogenerated"
    || descriptors.dirName?.value !== expectedDirectory
  ) {
    return fail(
      "DOCS_PRESET_SIDEBAR_CONFIG",
      `${label} 只能声明对应内容分区的 autogenerated slice。`,
    );
  }
}

function descriptorMapsEqual(
  left: PropertyDescriptorMap,
  right: PropertyDescriptorMap,
): boolean {
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (
    leftKeys.length !== rightKeys.length
    || leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    return false;
  }
  return leftKeys.every((key) => {
    const leftDescriptor = left[key];
    const rightDescriptor = right[key];
    if (leftDescriptor === undefined || rightDescriptor === undefined) return false;
    return leftDescriptor.configurable === rightDescriptor.configurable
      && leftDescriptor.enumerable === rightDescriptor.enumerable
      && leftDescriptor.get === rightDescriptor.get
      && leftDescriptor.set === rightDescriptor.set
      && leftDescriptor.writable === rightDescriptor.writable
      && Object.is(leftDescriptor.value, rightDescriptor.value);
  });
}

function readSidebarsModuleDescriptors(
  value: unknown,
  label: string,
): PropertyDescriptorMap {
  if (!isObject(value) || Array.isArray(value)) {
    return fail(
      "DOCS_PRESET_SIDEBAR_CONFIG",
      `${label} 必须是普通 object。`,
    );
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    return fail(
      "DOCS_PRESET_SIDEBAR_CONFIG",
      `${label} 无法安全读取。`,
      error,
    );
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(
      "DOCS_PRESET_SIDEBAR_CONFIG",
      `${label} 的 prototype 非法。`,
    );
  }
  if (Object.getOwnPropertySymbols(descriptors).length !== 0) {
    return fail(
      "DOCS_PRESET_SIDEBAR_CONFIG",
      `${label} 不得包含 symbol 字段。`,
    );
  }
  return descriptors;
}

function readStableSidebarsDefault(
  value: object,
  before: PropertyDescriptorMap,
  label: string,
): unknown {
  const descriptor = before.default;
  if (descriptor === undefined) {
    return fail(
      "DOCS_PRESET_SIDEBAR_CONFIG",
      `${label} 缺少唯一 default export。`,
    );
  }
  if ("value" in descriptor) {
    const after = readSidebarsModuleDescriptors(value, label);
    if (!descriptorMapsEqual(before, after)) {
      return fail(
        "DOCS_PRESET_SIDEBAR_CONFIG",
        `${label} 的 data default 在读取期间发生漂移。`,
      );
    }
    return descriptor.value;
  }
  if (typeof descriptor.get !== "function" || descriptor.set !== undefined) {
    return fail(
      "DOCS_PRESET_SIDEBAR_CONFIG",
      `${label}.default 必须是只读 getter。`,
    );
  }
  let first: unknown;
  let second: unknown;
  try {
    first = Reflect.apply(descriptor.get, value, []);
    const afterFirst = readSidebarsModuleDescriptors(value, label);
    if (!descriptorMapsEqual(before, afterFirst)) {
      return fail(
        "DOCS_PRESET_SIDEBAR_CONFIG",
        `${label}.default getter 首次调用改变了 module object。`,
      );
    }
    second = Reflect.apply(descriptor.get, value, []);
    const afterSecond = readSidebarsModuleDescriptors(value, label);
    if (!descriptorMapsEqual(before, afterSecond)) {
      return fail(
        "DOCS_PRESET_SIDEBAR_CONFIG",
        `${label}.default getter 重复调用改变了 module object。`,
      );
    }
  } catch (error) {
    if (error instanceof DocusaurusDocsAdapterError) throw error;
    return fail(
      "DOCS_PRESET_SIDEBAR_CONFIG",
      `${label}.default getter 调用失败。`,
      error,
    );
  }
  if (!Object.is(first, second)) {
    return fail(
      "DOCS_PRESET_SIDEBAR_CONFIG",
      `${label}.default getter 返回值 identity 不稳定。`,
    );
  }
  return first;
}

function assertExactSidebars(value: unknown): void {
  let candidate = value;
  const visited = new Set<object>();
  const namedExports: Array<Readonly<{
    projectsSidebar: unknown;
    writingSidebar: unknown;
  }>> = [];
  for (let depth = 0; depth < 8; depth += 1) {
    if (!isObject(candidate) || Array.isArray(candidate) || visited.has(candidate)) {
      return fail(
        "DOCS_PRESET_SIDEBAR_CONFIG",
        "sidebars.ts module 无法解析为唯一 default config。",
      );
    }
    visited.add(candidate);
    const descriptors = readSidebarsModuleDescriptors(
      candidate,
      `sidebars.ts module wrapper[${depth}]`,
    );
    const keys = Object.keys(descriptors).sort();
    const configKeys = keys.filter((key) => key !== "default");
    const hasExactConfigKeys = configKeys.length === 2
      && configKeys[0] === "projectsSidebar"
      && configKeys[1] === "writingSidebar";
    if (hasExactConfigKeys) {
      const projectsDescriptor = descriptors.projectsSidebar;
      const writingDescriptor = descriptors.writingSidebar;
      if (
        projectsDescriptor === undefined
        || writingDescriptor === undefined
        || !("value" in projectsDescriptor)
        || !("value" in writingDescriptor)
      ) {
        return fail(
          "DOCS_PRESET_SIDEBAR_CONFIG",
          "sidebars.ts 的两个 sidebar 必须是 data property。",
        );
      }
      const defaultDescriptor = descriptors.default;
      if (defaultDescriptor !== undefined) {
        const defaultExport = readStableSidebarsDefault(
          candidate,
          descriptors,
          `sidebars.ts module wrapper[${depth}]`,
        );
        if (defaultExport !== candidate) {
          namedExports.push(Object.freeze({
            projectsSidebar: projectsDescriptor.value,
            writingSidebar: writingDescriptor.value,
          }));
          candidate = defaultExport;
          continue;
        }
        if (
          "value" in defaultDescriptor
          || defaultDescriptor.enumerable !== false
          || defaultDescriptor.configurable !== false
        ) {
          return fail(
            "DOCS_PRESET_SIDEBAR_CONFIG",
            "sidebars.ts 的自引用 default 只能是 Jiti 只读 getter。",
          );
        }
      }
      for (const named of namedExports) {
        if (
          named.projectsSidebar !== projectsDescriptor.value
          || named.writingSidebar !== writingDescriptor.value
        ) {
          return fail(
            "DOCS_PRESET_SIDEBAR_CONFIG",
            "sidebars.ts module 的 named/default export identity 不一致。",
          );
        }
      }
      assertExactAutogeneratedSlice(
        projectsDescriptor.value,
        "projects",
        "sidebars.projectsSidebar",
      );
      assertExactAutogeneratedSlice(
        writingDescriptor.value,
        "writing",
        "sidebars.writingSidebar",
      );
      return;
    }
    const allowedWrapperKeys = new Set([
      "__esModule",
      "default",
      "projectsSidebar",
      "writingSidebar",
    ]);
    if (
      descriptors.default === undefined
      || keys.some((key) => !allowedWrapperKeys.has(key))
      || (descriptors.__esModule !== undefined
        && (!("value" in descriptors.__esModule)
          || descriptors.__esModule.value !== true))
    ) {
      return fail(
        "DOCS_PRESET_SIDEBAR_CONFIG",
        "sidebars.ts module wrapper 字段集合发生漂移。",
      );
    }
    const hasProjects = descriptors.projectsSidebar !== undefined;
    const hasWriting = descriptors.writingSidebar !== undefined;
    if (hasProjects !== hasWriting) {
      return fail(
        "DOCS_PRESET_SIDEBAR_CONFIG",
        "sidebars.ts module 的 named exports 不完整。",
      );
    }
    if (hasProjects && hasWriting) {
      const projectsDescriptor = descriptors.projectsSidebar;
      const writingDescriptor = descriptors.writingSidebar;
      if (
        projectsDescriptor === undefined
        || writingDescriptor === undefined
        || !("value" in projectsDescriptor)
        || !("value" in writingDescriptor)
      ) {
        return fail(
          "DOCS_PRESET_SIDEBAR_CONFIG",
          "sidebars.ts module 的 named exports 必须是 data property。",
        );
      }
      namedExports.push(Object.freeze({
        projectsSidebar: projectsDescriptor.value,
        writingSidebar: writingDescriptor.value,
      }));
    }
    const next = readStableSidebarsDefault(
      candidate,
      descriptors,
      `sidebars.ts module wrapper[${depth}]`,
    );
    if (next === candidate) {
      return fail(
        "DOCS_PRESET_SIDEBAR_CONFIG",
        "sidebars.ts module default 形成无配置自引用。",
      );
    }
    candidate = next;
  }
  return fail(
    "DOCS_PRESET_SIDEBAR_CONFIG",
    "sidebars.ts module default wrapper 层级超出上限。",
  );
}

function assertExactDocsOptions(
  value: Record<string, unknown>,
  sidebarItemsGenerator: unknown,
  projectPreviewRemarkPlugin: unknown,
): void {
  const descriptors = readPlainDataDescriptors(value, "本地 docs options");
  const expectedKeys = [
    "includeCurrentVersion",
    "onlyIncludeVersions",
    "path",
    "remarkPlugins",
    "routeBasePath",
    "sidebarItemsGenerator",
    "sidebarPath",
    "tags",
  ].sort();
  const keys = Object.keys(descriptors).sort();
  const versions = snapshotDenseArray(
    descriptors.onlyIncludeVersions?.value,
    "docs.onlyIncludeVersions",
  );
  const remarkPlugins = snapshotDenseArray(
    descriptors.remarkPlugins?.value,
    "docs.remarkPlugins",
  );
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || descriptors.path?.value !== "site-content"
    || descriptors.routeBasePath?.value !== "/"
    || descriptors.sidebarPath?.value !== "./sidebars.ts"
    || descriptors.includeCurrentVersion?.value !== true
    || versions.length !== 1
    || versions[0] !== "current"
    || remarkPlugins.length !== 1
    || remarkPlugins[0] !== projectPreviewRemarkPlugin
    || descriptors.tags?.value !== false
    || descriptors.sidebarItemsGenerator?.value !== sidebarItemsGenerator
  ) {
    return fail(
      "DOCS_PRESET_DOCS_CONFIG",
      "presetClassic 调用期间修改了 current-only 唯一 docs options。",
    );
  }
}

function inspectOfficialDocsTuples(
  plugins: readonly PluginConfig[],
  docsOptions: object,
): readonly Readonly<{config: readonly unknown[]; index: number}>[] {
  const candidates: Array<Readonly<{config: readonly unknown[]; index: number}>> = [];
  for (const [index, config] of plugins.entries()) {
    if (!Array.isArray(config)) continue;
    const tuple = snapshotDenseArray(config, `presetClassic.plugins[${index}]`);
    const pluginPath = tuple[0];
    const usesInputOptions = tuple[1] === docsOptions;
    if (typeof pluginPath !== "string") {
      if (usesInputOptions) {
        return fail(
          "DOCS_PRESET_DOCS_CONFIG",
          "复用本地 docs options 的 plugin tuple 缺少 string 入口。",
        );
      }
      continue;
    }
    const normalized = pluginPath.replaceAll("\\", "/");
    if (!usesInputOptions && !normalized.endsWith(DOCS_PLUGIN_PATH_SUFFIX)) continue;
    assertExactDocsPluginPath(pluginPath);
    candidates.push(Object.freeze({config: tuple, index}));
  }
  return Object.freeze(candidates);
}

function assertSingleContentAssembly(
  context: LoadContext,
  options: unknown,
): void {
  const siteConfig = readPlainDataDescriptors(context.siteConfig, "Docusaurus siteConfig");
  const plugins = snapshotDenseArray(siteConfig.plugins?.value, "siteConfig.plugins");
  const themes = snapshotDenseArray(siteConfig.themes?.value, "siteConfig.themes");
  const presets = snapshotDenseArray(siteConfig.presets?.value, "siteConfig.presets");
  if (plugins.length !== 0 || themes.length !== 0 || presets.length !== 1) {
    return fail(
      "DOCS_PRESET_SITE_CONFIG",
      "根配置只能通过唯一 local preset 装配 plugins/themes/docs。",
    );
  }
  const preset = snapshotDenseArray(presets[0], "siteConfig.presets[0]");
  if (
    preset.length !== 2
    || preset[0] !== LOCAL_PRESET_PATH
    || preset[1] !== options
  ) {
    return fail(
      "DOCS_PRESET_SITE_CONFIG",
      "根配置中的唯一内容 preset 路径或 options identity 发生漂移。",
    );
  }
}

export function resolveClassicPresetModule(value: unknown): ClassicPreset {
  if (typeof value === "function") {
    return value as ClassicPreset;
  }
  if (isObject(value) && !Array.isArray(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, "default");
    if (
      descriptor !== undefined
      && "value" in descriptor
      && typeof descriptor.value === "function"
    ) {
      return descriptor.value as ClassicPreset;
    }
  }
  return fail(
    "DOCS_PRESET_CLASSIC_MODULE",
    "@docusaurus/preset-classic 导出结构发生漂移。",
  );
}

export function createClassicDerivedPreset(
  dependencies: ClassicDerivedPresetDependencies,
): ClassicDerivedPreset {
  if (typeof dependencies.presetClassic !== "function") {
    return fail("DOCS_PRESET_CLASSIC_MODULE", "presetClassic dependency 必须是 function。");
  }
  if (typeof dependencies.loadFreshModule !== "function") {
    return fail("DOCS_PRESET_PLUGIN_MODULE", "loadFreshModule dependency 必须是 function。");
  }
  assertExactSidebars(dependencies.sidebars);
  if (
    typeof dependencies.createContentBuildSession !== "function"
    || typeof dependencies.sessionSidebarItemsGenerator !== "function"
    || typeof dependencies.sessionProjectPreviewRemarkPlugin !== "function"
    || typeof dependencies.createContentDataPlugin !== "function"
  ) {
    return fail("DOCS_PRESET_SESSION", "content session dependencies 不完整。");
  }

  return async function classicDerivedPreset(context, options) {
    assertSingleContentAssembly(context, options);
    assertExactSidebars(dependencies.sidebars);
    const callerOptions = readClassicOptions(options);
    const session = await dependencies.createContentBuildSession(context);
    const sidebarItemsGenerator = dependencies.sessionSidebarItemsGenerator(session);
    const projectPreviewRemarkPlugin = dependencies.sessionProjectPreviewRemarkPlugin(session);
    if (typeof projectPreviewRemarkPlugin !== "function") {
      return fail(
        "DOCS_PRESET_SESSION",
        "同一内容 session 没有提供项目主预览 remark plugin。",
      );
    }
    const remarkPlugins: unknown[] = [projectPreviewRemarkPlugin];
    Object.freeze(remarkPlugins);
    const docsOptions = {
      path: "site-content",
      routeBasePath: "/",
      sidebarPath: "./sidebars.ts",
      includeCurrentVersion: true,
      onlyIncludeVersions: Object.freeze(["current"]),
      tags: false,
      sidebarItemsGenerator,
      remarkPlugins,
    };
    assertExactDocsOptions(
      docsOptions,
      sidebarItemsGenerator,
      projectPreviewRemarkPlugin,
    );
    const classicOptions = {
      ...callerOptions,
      docs: docsOptions,
    } as ClassicPresetOptions;
    const inspected = inspectClassicPreset(
      dependencies.presetClassic(context, classicOptions),
    );
    assertExactSidebars(dependencies.sidebars);
    assertExactDocsOptions(
      docsOptions,
      sidebarItemsGenerator,
      projectPreviewRemarkPlugin,
    );
    const candidates = inspectOfficialDocsTuples(inspected.plugins, docsOptions);
    if (
      candidates.length !== 1
      || candidates[0]?.config.length !== 2
      || candidates[0].config[1] !== docsOptions
    ) {
      return fail(
        "DOCS_PRESET_DOCS_CONFIG",
        "presetClassic 必须返回唯一官方 docs 实例并复用输入 options identity。",
      );
    }
    const candidate = candidates[0];
    if (candidate === undefined) {
      return fail("DOCS_PRESET_DOCS_CONFIG", "无法读取唯一 docs plugin config。");
    }
    const pluginPath = candidate.config[0];
    if (typeof pluginPath !== "string") {
      return fail("DOCS_PRESET_DOCS_CONFIG", "docs plugin config 入口必须是 string。");
    }
    assertExactDocsPluginPath(pluginPath);

    const loadedModule = await dependencies.loadFreshModule(pluginPath);
    if (typeof loadedModule !== "function") {
      return fail(
        "DOCS_PRESET_PLUGIN_MODULE",
        "loadFreshModule 未返回固定版本官方 docs plugin function。",
      );
    }
    const adapter = createDocusaurusDocsAdapter(
      loadedModule as PluginModule<unknown>,
      () => session.docsAdapterSession,
    );
    const plugins: PluginConfig[] = inspected.plugins.map((config, index): PluginConfig => (
      index === candidate.index
        ? [adapter, docsOptions]
        : config
    ));
    plugins.push(dependencies.createContentDataPlugin(session) as PluginConfig);
    return {
      themes: inspected.preset.themes,
      plugins,
    };
  };
}
