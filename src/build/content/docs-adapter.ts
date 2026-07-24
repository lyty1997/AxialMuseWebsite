import type {
  LoadContext,
  Plugin,
  PluginModule,
} from "@docusaurus/types";
import {dirname, isAbsolute, resolve} from "node:path";

const OFFICIAL_PLUGIN_NAME = "docusaurus-plugin-content-docs";
const OFFICIAL_PLUGIN_LIFECYCLES = Object.freeze([
  "configureWebpack",
  "contentLoaded",
  "extendCli",
  "getPathsToWatch",
  "getTranslationFiles",
  "loadContent",
  "name",
  "translateContent",
]);
const LOADED_VERSION_KEYS = Object.freeze([
  "badge",
  "banner",
  "className",
  "contentPath",
  "contentPathLocalized",
  "docs",
  "drafts",
  "editUrl",
  "editUrlLocalized",
  "isLast",
  "label",
  "noIndex",
  "path",
  "routePriority",
  "sidebarFilePath",
  "sidebars",
  "tagsPath",
  "versionName",
]);

export class DocusaurusDocsAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "DocusaurusDocsAdapterError";
    this.code = code;
  }
}

export interface CurrentDocsContentSnapshot {
  readonly content: object;
  readonly version: object;
  readonly docs: readonly unknown[];
  readonly drafts: readonly unknown[];
}

export interface DocusaurusDocsAdapterSession {
  readonly mode: "production" | "preview";
  readonly expectedVersion: Readonly<{
    path: string;
    contentPath: string;
    sidebarFilePath: string;
  }>;
  readonly assertCurrentDocsContent: (
    snapshot: CurrentDocsContentSnapshot,
  ) => void | Promise<void>;
}

export interface CreateDocusaurusDocsAdapterSessionInput {
  readonly context: LoadContext;
  readonly options: unknown;
}

export type CreateDocusaurusDocsAdapterSession = (
  input: CreateDocusaurusDocsAdapterSessionInput,
) => DocusaurusDocsAdapterSession;

interface ContentShapeSnapshot extends CurrentDocsContentSnapshot {
  readonly loadedVersions: readonly unknown[];
  readonly versionValues: ReadonlyMap<string, unknown>;
  readonly objectGraph: readonly ObjectGraphNodeSnapshot[];
}

interface ContentLoadedArgumentsSnapshot {
  readonly args: object;
  readonly actions: object;
  readonly content: object;
  readonly objectGraph: readonly ObjectGraphNodeSnapshot[];
}

interface ObjectGraphNodeSnapshot {
  readonly target: object;
  readonly prototype: object | null;
  readonly properties: readonly (readonly [PropertyKey, PropertyDescriptor])[];
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

function assertPlainObject(value: unknown, label: string): asserts value is object {
  if (!isObject(value) || Array.isArray(value)) {
    fail("DOCS_ADAPTER_CONTENT_SHAPE", `${label} 必须是普通 object。`);
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch (error) {
    fail("DOCS_ADAPTER_CONTENT_SHAPE", `${label} 无法安全读取 prototype。`, error);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail("DOCS_ADAPTER_CONTENT_SHAPE", `${label} 的 prototype 不符合固定结构。`);
  }
}

function ownDescriptors(value: object, label: string): PropertyDescriptorMap {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    return fail(
      "DOCS_ADAPTER_CONTENT_SHAPE",
      `${label} 无法安全读取 own property descriptors。`,
      error,
    );
  }
}

function assertExactDataKeys(
  value: object,
  expectedKeys: readonly string[],
  label: string,
  code = "DOCS_ADAPTER_CONTENT_SHAPE",
): PropertyDescriptorMap {
  const descriptors = ownDescriptors(value, label);
  const symbols = Object.getOwnPropertySymbols(descriptors);
  const actualKeys = Object.keys(descriptors).sort();
  const expected = [...expectedKeys].sort();
  if (
    symbols.length !== 0
    || actualKeys.length !== expected.length
    || actualKeys.some((key, index) => key !== expected[index])
  ) {
    fail(code, `${label} 的字段集合发生漂移。`);
  }
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      fail(code, `${label}.${key} 必须是 own data property。`);
    }
  }
  return descriptors;
}

function readDataValue(
  descriptors: PropertyDescriptorMap,
  key: string,
  label: string,
): unknown {
  const descriptor = descriptors[key];
  if (descriptor === undefined || !("value" in descriptor)) {
    return fail(
      "DOCS_ADAPTER_CONTENT_SHAPE",
      `${label}.${key} 必须是 own data property。`,
    );
  }
  return descriptor.value;
}

function snapshotDenseArray(value: unknown, label: string): readonly unknown[] {
  let isArray: boolean;
  let prototype: object | null;
  try {
    isArray = Array.isArray(value);
    prototype = isArray ? Object.getPrototypeOf(value) : null;
  } catch (error) {
    return fail(
      "DOCS_ADAPTER_CONTENT_SHAPE",
      `${label} 无法安全读取 Array 结构。`,
      error,
    );
  }
  if (!isArray || prototype !== Array.prototype) {
    fail("DOCS_ADAPTER_CONTENT_SHAPE", `${label} 必须是普通 Array。`);
  }
  const descriptors = ownDescriptors(value as unknown[], label);
  if (Object.getOwnPropertySymbols(descriptors).length !== 0) {
    fail("DOCS_ADAPTER_CONTENT_SHAPE", `${label} 不得包含 symbol 字段。`);
  }
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    return fail("DOCS_ADAPTER_CONTENT_SHAPE", `${label}.length 结构非法。`);
  }
  const expectedKeys = Array.from(
    {length: lengthDescriptor.value as number},
    (_, index) => String(index),
  );
  const actualKeys = Object.keys(descriptors)
    .filter((key) => key !== "length")
    .sort((left, right) => Number(left) - Number(right));
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    fail("DOCS_ADAPTER_CONTENT_SHAPE", `${label} 必须是无附加字段的稠密 Array。`);
  }
  const snapshot = expectedKeys.map((key) => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      return fail(
        "DOCS_ADAPTER_CONTENT_SHAPE",
        `${label}[${key}] 必须是 own data property。`,
      );
    }
    return descriptor.value;
  });
  return Object.freeze(snapshot);
}

function assertString(value: unknown, label: string): void {
  if (typeof value !== "string") {
    fail("DOCS_ADAPTER_CONTENT_SHAPE", `${label} 必须是 string。`);
  }
}

function snapshotObjectGraph(root: object): readonly ObjectGraphNodeSnapshot[] {
  const pending: object[] = [root];
  const visited = new Set<object>();
  const snapshots: ObjectGraphNodeSnapshot[] = [];
  while (pending.length > 0) {
    const target = pending.pop();
    if (target === undefined || visited.has(target)) continue;
    visited.add(target);
    let prototype: object | null;
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = Object.getPrototypeOf(target);
      descriptors = Object.getOwnPropertyDescriptors(target);
    } catch (error) {
      return fail(
        "DOCS_ADAPTER_CONTENT_SHAPE",
        "docs 内容对象图无法安全读取。",
        error,
      );
    }
    const properties = Reflect.ownKeys(descriptors).map((key) => {
      const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
      if (
        "value" in descriptor
        && typeof descriptor.value === "object"
        && descriptor.value !== null
      ) {
        pending.push(descriptor.value);
      }
      return Object.freeze([key, Object.freeze({...descriptor})] as const);
    });
    snapshots.push(Object.freeze({
      target,
      prototype,
      properties: Object.freeze(properties),
    }));
  }
  return Object.freeze(snapshots);
}

function sameDescriptor(
  before: PropertyDescriptor,
  after: PropertyDescriptor,
): boolean {
  if (
    before.configurable !== after.configurable
    || before.enumerable !== after.enumerable
    || ("value" in before) !== ("value" in after)
  ) {
    return false;
  }
  if ("value" in before && "value" in after) {
    return before.writable === after.writable && Object.is(before.value, after.value);
  }
  return before.get === after.get && before.set === after.set;
}

function assertObjectGraphUnchanged(
  snapshots: readonly ObjectGraphNodeSnapshot[],
): void {
  for (const snapshot of snapshots) {
    let prototype: object | null;
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = Object.getPrototypeOf(snapshot.target);
      descriptors = Object.getOwnPropertyDescriptors(snapshot.target);
    } catch (error) {
      return fail(
        "DOCS_ADAPTER_CONTENT_MUTATION",
        "docs session 校验期间使框架内容对象不可读。",
        error,
      );
    }
    const keys = Reflect.ownKeys(descriptors);
    if (
      prototype !== snapshot.prototype
      || keys.length !== snapshot.properties.length
      || keys.some((key, index) => key !== snapshot.properties[index]?.[0])
    ) {
      return fail(
        "DOCS_ADAPTER_CONTENT_MUTATION",
        "docs session 校验期间修改了框架内容对象结构。",
      );
    }
    for (let index = 0; index < keys.length; index += 1) {
      const before = snapshot.properties[index]?.[1];
      const after = Reflect.get(descriptors, keys[index]!) as PropertyDescriptor;
      if (before === undefined || !sameDescriptor(before, after)) {
        return fail(
          "DOCS_ADAPTER_CONTENT_MUTATION",
          "docs session 校验期间修改了框架内容字段。",
        );
      }
    }
  }
}

function inspectContentLoadedArguments(
  value: unknown,
): ContentLoadedArgumentsSnapshot {
  assertPlainObject(value, "contentLoaded args");
  const descriptors = assertExactDataKeys(
    value,
    ["actions", "content"],
    "contentLoaded args",
  );
  const actions = readDataValue(descriptors, "actions", "contentLoaded args");
  assertPlainObject(actions, "contentLoaded args.actions");
  const actionDescriptors = assertExactDataKeys(
    actions,
    ["addRoute", "createData", "setGlobalData"],
    "contentLoaded args.actions",
  );
  for (const key of ["addRoute", "createData", "setGlobalData"]) {
    if (
      typeof readDataValue(
        actionDescriptors,
        key,
        "contentLoaded args.actions",
      ) !== "function"
    ) {
      fail(
        "DOCS_ADAPTER_CONTENT_SHAPE",
        `contentLoaded args.actions.${key} 必须是 function。`,
      );
    }
  }
  const content = readDataValue(descriptors, "content", "contentLoaded args");
  assertPlainObject(content, "contentLoaded args.content");
  return Object.freeze({
    args: value,
    actions,
    content,
    objectGraph: snapshotObjectGraph(value),
  });
}

function assertSameContentLoadedArguments(
  before: ContentLoadedArgumentsSnapshot,
  after: ContentLoadedArgumentsSnapshot,
): void {
  if (
    before.args !== after.args
    || before.actions !== after.actions
    || before.content !== after.content
  ) {
    fail(
      "DOCS_ADAPTER_CONTENT_MUTATION",
      "官方 docs lifecycle 替换了原始 args、actions 或 content 身份。",
    );
  }
  assertObjectGraphUnchanged(before.objectGraph);
}

function clonePlainObjectReplacingDataValue(
  value: object,
  key: string,
  replacement: unknown,
  label: string,
): object {
  const descriptors = ownDescriptors(value, label);
  const descriptor = descriptors[key];
  if (descriptor === undefined || !("value" in descriptor)) {
    return fail(
      "DOCS_ADAPTER_CONTENT_SHAPE",
      `${label}.${key} 必须是 own data property。`,
    );
  }
  descriptors[key] = {...descriptor, value: replacement};
  try {
    return Object.create(Object.getPrototypeOf(value), descriptors) as object;
  } catch (error) {
    return fail(
      "DOCS_ADAPTER_CONTENT_SHAPE",
      `${label} 无法安全克隆。`,
      error,
    );
  }
}

function cloneSingleEntryArray(
  value: readonly unknown[],
  replacement: unknown,
  label: string,
): unknown[] {
  const descriptors = ownDescriptors(value as unknown as object, label);
  const itemDescriptor = descriptors["0"];
  const lengthDescriptor = descriptors.length;
  if (
    itemDescriptor === undefined
    || !("value" in itemDescriptor)
    || lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || lengthDescriptor.value !== 1
  ) {
    return fail(
      "DOCS_ADAPTER_CONTENT_SHAPE",
      `${label} 不再是单一 current version Array。`,
    );
  }
  const clone: unknown[] = [];
  try {
    Object.defineProperty(clone, "0", {...itemDescriptor, value: replacement});
    Object.defineProperty(clone, "length", {...lengthDescriptor, value: 1});
  } catch (error) {
    return fail(
      "DOCS_ADAPTER_CONTENT_SHAPE",
      `${label} 无法安全克隆。`,
      error,
    );
  }
  return clone;
}

function createProductionContentProjection(
  argsSnapshot: ContentLoadedArgumentsSnapshot,
  contentSnapshot: ContentShapeSnapshot,
): Readonly<{
  args: object;
  content: ContentShapeSnapshot;
  argsObjectGraph: readonly ObjectGraphNodeSnapshot[];
}> {
  const projectedVersion = clonePlainObjectReplacingDataValue(
    contentSnapshot.version,
    "drafts",
    [],
    "contentLoaded projection.version",
  );
  const projectedVersions = cloneSingleEntryArray(
    contentSnapshot.loadedVersions,
    projectedVersion,
    "contentLoaded projection.loadedVersions",
  );
  const projectedContent = clonePlainObjectReplacingDataValue(
    contentSnapshot.content,
    "loadedVersions",
    projectedVersions,
    "contentLoaded projection.content",
  );
  const projectedSnapshot = inspectCurrentDocsContent(projectedContent, false);
  const versionIdentityDrift = LOADED_VERSION_KEYS.some((key) => (
    key !== "drafts"
    && projectedSnapshot.versionValues.get(key)
      !== contentSnapshot.versionValues.get(key)
  ));
  if (
    projectedSnapshot.docs.length !== contentSnapshot.docs.length
    || projectedSnapshot.drafts.length !== 0
    || projectedSnapshot.versionValues.get("docs")
      !== contentSnapshot.versionValues.get("docs")
    || projectedSnapshot.loadedVersions !== projectedVersions
    || versionIdentityDrift
  ) {
    fail(
      "DOCS_ADAPTER_CONTENT_PROJECTION",
      "production docs 投影未精确保留公开 docs 或未清空 drafts。",
    );
  }
  const argsDescriptors = ownDescriptors(
    argsSnapshot.args,
    "contentLoaded projection args",
  );
  const contentDescriptor = argsDescriptors.content;
  if (contentDescriptor === undefined || !("value" in contentDescriptor)) {
    return fail(
      "DOCS_ADAPTER_CONTENT_SHAPE",
      "contentLoaded projection args.content 必须是 own data property。",
    );
  }
  argsDescriptors.content = {
    ...contentDescriptor,
    value: projectedSnapshot.content,
  };
  let projectedArgs: object;
  try {
    projectedArgs = Object.create(
      Object.getPrototypeOf(argsSnapshot.args),
      argsDescriptors,
    ) as object;
  } catch (error) {
    return fail(
      "DOCS_ADAPTER_CONTENT_SHAPE",
      "无法创建受控 production contentLoaded 投影。",
      error,
    );
  }
  const inspectedArgs = inspectContentLoadedArguments(projectedArgs);
  if (inspectedArgs.actions !== argsSnapshot.actions) {
    fail(
      "DOCS_ADAPTER_CONTENT_PROJECTION",
      "production docs 投影改变了官方 actions 身份。",
    );
  }
  return Object.freeze({
    args: projectedArgs,
    content: projectedSnapshot,
    argsObjectGraph: snapshotObjectGraph(projectedArgs),
  });
}

function inspectCurrentDocsContent(
  value: unknown,
  expectedNoIndex: boolean,
): ContentShapeSnapshot {
  assertPlainObject(value, "contentLoaded.content");
  const contentDescriptors = assertExactDataKeys(
    value,
    ["loadedVersions"],
    "contentLoaded.content",
  );
  const loadedVersionsValue = readDataValue(
    contentDescriptors,
    "loadedVersions",
    "contentLoaded.content",
  );
  const loadedVersions = snapshotDenseArray(
    loadedVersionsValue,
    "contentLoaded.content.loadedVersions",
  );
  if (loadedVersions.length !== 1) {
    fail(
      "DOCS_ADAPTER_CONTENT_SHAPE",
      "docs 内容必须精确包含一个 current version。",
    );
  }

  const version = loadedVersions[0];
  assertPlainObject(version, "contentLoaded.content.loadedVersions[0]");
  const versionDescriptors = assertExactDataKeys(
    version,
    LOADED_VERSION_KEYS,
    "contentLoaded.content.loadedVersions[0]",
  );
  const versionValues = new Map<string, unknown>();
  for (const key of LOADED_VERSION_KEYS) {
    versionValues.set(
      key,
      readDataValue(versionDescriptors, key, "contentLoaded.content.loadedVersions[0]"),
    );
  }

  if (versionValues.get("versionName") !== "current") {
    fail("DOCS_ADAPTER_CONTENT_SHAPE", "唯一 docs version 必须是 current。");
  }
  if (versionValues.get("isLast") !== true || versionValues.get("routePriority") !== -1) {
    fail(
      "DOCS_ADAPTER_CONTENT_SHAPE",
      "current-only docs version 必须同时是 last version 且 routePriority=-1。",
    );
  }
  if (
    versionValues.get("contentPathLocalized") !== undefined
    || versionValues.get("editUrlLocalized") !== undefined
  ) {
    fail("DOCS_ADAPTER_CONTENT_SHAPE", "docs 内容不得携带 localized 第二内容根。");
  }
  for (const key of ["className", "contentPath", "label", "path", "tagsPath"]) {
    assertString(versionValues.get(key), `contentLoaded.content.loadedVersions[0].${key}`);
  }
  for (const key of ["badge", "noIndex"]) {
    if (typeof versionValues.get(key) !== "boolean") {
      fail(
        "DOCS_ADAPTER_CONTENT_SHAPE",
        `contentLoaded.content.loadedVersions[0].${key} 必须是 boolean。`,
      );
    }
  }
  if (versionValues.get("noIndex") !== expectedNoIndex) {
    fail(
      "DOCS_ADAPTER_CONTENT_SHAPE",
      `docs version noIndex 必须与 ${expectedNoIndex ? "preview" : "production"} 模式一致。`,
    );
  }
  const banner = versionValues.get("banner");
  if (banner !== null && typeof banner !== "string") {
    fail("DOCS_ADAPTER_CONTENT_SHAPE", "docs version banner 必须是 string 或 null。");
  }
  const editUrl = versionValues.get("editUrl");
  if (editUrl !== undefined && typeof editUrl !== "string") {
    fail("DOCS_ADAPTER_CONTENT_SHAPE", "docs version editUrl 必须是 string 或 undefined。");
  }
  const sidebarFilePath = versionValues.get("sidebarFilePath");
  if (
    sidebarFilePath !== undefined
    && sidebarFilePath !== false
    && typeof sidebarFilePath !== "string"
  ) {
    fail(
      "DOCS_ADAPTER_CONTENT_SHAPE",
      "docs version sidebarFilePath 必须是 string、false 或 undefined。",
    );
  }
  assertPlainObject(versionValues.get("sidebars"), "docs version sidebars");

  const docs = snapshotDenseArray(versionValues.get("docs"), "docs version docs");
  const drafts = snapshotDenseArray(versionValues.get("drafts"), "docs version drafts");
  return Object.freeze({
    content: value,
    loadedVersions: loadedVersionsValue as readonly unknown[],
    version,
    docs,
    drafts,
    versionValues,
    objectGraph: snapshotObjectGraph(value),
  });
}

function assertSameSnapshot(
  before: ContentShapeSnapshot,
  after: ContentShapeSnapshot,
): void {
  if (before.content !== after.content || before.version !== after.version) {
    fail("DOCS_ADAPTER_CONTENT_MUTATION", "docs session 校验期间替换了框架内容对象。");
  }
  for (const key of LOADED_VERSION_KEYS) {
    if (before.versionValues.get(key) !== after.versionValues.get(key)) {
      fail(
        "DOCS_ADAPTER_CONTENT_MUTATION",
        `docs session 校验期间修改了 version.${key}。`,
      );
    }
  }
  for (const key of ["docs", "drafts"] as const) {
    const left = before[key];
    const right = after[key];
    if (
      left.length !== right.length
      || left.some((item, index) => item !== right[index])
    ) {
      fail(
        "DOCS_ADAPTER_CONTENT_MUTATION",
        `docs session 校验期间修改了 version.${key} 成员。`,
      );
    }
  }
  assertObjectGraphUnchanged(before.objectGraph);
}

function inspectExpectedVersion(value: unknown): Readonly<{
  path: string;
  contentPath: string;
  sidebarFilePath: string;
}> {
  assertPlainObject(value, "docs adapter session.expectedVersion");
  const descriptors = assertExactDataKeys(
    value,
    ["contentPath", "path", "sidebarFilePath"],
    "docs adapter session.expectedVersion",
    "DOCS_ADAPTER_SESSION",
  );
  const path = readDataValue(descriptors, "path", "docs adapter session.expectedVersion");
  const contentPath = readDataValue(
    descriptors,
    "contentPath",
    "docs adapter session.expectedVersion",
  );
  const sidebarFilePath = readDataValue(
    descriptors,
    "sidebarFilePath",
    "docs adapter session.expectedVersion",
  );
  if (
    path !== "/"
    || typeof contentPath !== "string"
    || typeof sidebarFilePath !== "string"
    || !isAbsolute(contentPath)
    || !isAbsolute(sidebarFilePath)
    || resolve(contentPath) !== contentPath
    || resolve(sidebarFilePath) !== sidebarFilePath
  ) {
    fail(
      "DOCS_ADAPTER_SESSION",
      "docs adapter session 的 current version 路径身份不合法。",
    );
  }
  const repositoryRoot = dirname(sidebarFilePath);
  if (
    sidebarFilePath !== resolve(repositoryRoot, "sidebars.ts")
    || contentPath !== resolve(repositoryRoot, "site-content")
  ) {
    fail(
      "DOCS_ADAPTER_SESSION",
      "docs adapter session 未绑定同一仓库根的内容与侧栏。",
    );
  }
  return Object.freeze({path, contentPath, sidebarFilePath});
}

function assertExpectedVersion(
  snapshot: ContentShapeSnapshot,
  expected: Readonly<{
    path: string;
    contentPath: string;
    sidebarFilePath: string;
  }>,
): void {
  if (
    snapshot.versionValues.get("path") !== expected.path
    || snapshot.versionValues.get("contentPath") !== expected.contentPath
    || snapshot.versionValues.get("sidebarFilePath") !== expected.sidebarFilePath
  ) {
    fail(
      "DOCS_ADAPTER_VERSION_IDENTITY",
      "current docs version 未绑定唯一物理内容根、根路由或侧栏文件。",
    );
  }
}

function assertAdapterSession(value: unknown): asserts value is DocusaurusDocsAdapterSession {
  assertPlainObject(value, "docs adapter session");
  const descriptors = assertExactDataKeys(
    value,
    ["assertCurrentDocsContent", "expectedVersion", "mode"],
    "docs adapter session",
    "DOCS_ADAPTER_SESSION",
  );
  const mode = readDataValue(descriptors, "mode", "docs adapter session");
  const assertCurrentDocsContent = readDataValue(
    descriptors,
    "assertCurrentDocsContent",
    "docs adapter session",
  );
  inspectExpectedVersion(readDataValue(descriptors, "expectedVersion", "docs adapter session"));
  if (mode !== "production" && mode !== "preview") {
    fail("DOCS_ADAPTER_SESSION", "docs adapter session mode 非法。");
  }
  if (typeof assertCurrentDocsContent !== "function") {
    fail("DOCS_ADAPTER_SESSION", "docs adapter session 缺少内容对应校验 callback。");
  }
}

function assertOfficialPlugin(value: unknown): asserts value is Plugin<unknown> {
  assertPlainObject(value, "官方 docs plugin 实例");
  const descriptors = assertExactDataKeys(
    value,
    OFFICIAL_PLUGIN_LIFECYCLES,
    "官方 docs plugin 实例",
    "DOCS_ADAPTER_PLUGIN_INSTANCE",
  );
  if (readDataValue(descriptors, "name", "官方 docs plugin 实例") !== OFFICIAL_PLUGIN_NAME) {
    fail("DOCS_ADAPTER_PLUGIN_INSTANCE", "官方 docs plugin name 发生漂移。");
  }
  for (const key of OFFICIAL_PLUGIN_LIFECYCLES.filter((key) => key !== "name")) {
    if (typeof readDataValue(descriptors, key, "官方 docs plugin 实例") !== "function") {
      fail(
        "DOCS_ADAPTER_PLUGIN_INSTANCE",
        `官方 docs plugin lifecycle ${key} 缺失或发生漂移。`,
      );
    }
  }
}

function wrapOfficialPlugin(
  plugin: Plugin<unknown>,
  session: DocusaurusDocsAdapterSession,
): Plugin<unknown> {
  assertOfficialPlugin(plugin);
  const originalContentLoaded = plugin.contentLoaded;
  if (typeof originalContentLoaded !== "function") {
    return fail(
      "DOCS_ADAPTER_PLUGIN_INSTANCE",
      "官方 docs plugin 缺少 contentLoaded lifecycle。",
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(plugin);
  const originalDescriptor = descriptors.contentLoaded;
  if (originalDescriptor === undefined || !("value" in originalDescriptor)) {
    return fail(
      "DOCS_ADAPTER_PLUGIN_INSTANCE",
      "官方 docs plugin contentLoaded descriptor 发生漂移。",
    );
  }
  const mode = session.mode;
  const expectedVersion = inspectExpectedVersion(session.expectedVersion);
  const assertCurrentDocsContent = session.assertCurrentDocsContent;
  descriptors.contentLoaded = {
    ...originalDescriptor,
    value: async function adaptedContentLoaded(args) {
      const argsBefore = inspectContentLoadedArguments(args);
      const before = inspectCurrentDocsContent(
        argsBefore.content,
        mode === "preview",
      );
      assertExpectedVersion(before, expectedVersion);
      await assertCurrentDocsContent.call(session, Object.freeze({
        content: before.content,
        version: before.version,
        docs: before.docs,
        drafts: before.drafts,
      }));
      const argsAfterValidation = inspectContentLoadedArguments(args);
      assertSameContentLoadedArguments(argsBefore, argsAfterValidation);
      const afterValidation = inspectCurrentDocsContent(
        argsAfterValidation.content,
        mode === "preview",
      );
      assertSameSnapshot(before, afterValidation);
      if (mode === "production" && before.docs.length === 0) {
        return;
      }

      const projection = mode === "production"
        ? createProductionContentProjection(argsBefore, before)
        : undefined;
      if (projection !== undefined) {
        assertExpectedVersion(projection.content, expectedVersion);
      }
      let delegation: Readonly<
        | {ok: true; result: void}
        | {error: unknown; ok: false}
      >;
      try {
        const result = await originalContentLoaded.call(
          this,
          (projection?.args ?? args) as never,
        );
        delegation = Object.freeze({ok: true, result});
      } catch (error) {
        delegation = Object.freeze({error, ok: false});
      }

      const argsAfterDelegation = inspectContentLoadedArguments(args);
      assertSameContentLoadedArguments(argsBefore, argsAfterDelegation);
      const afterDelegation = inspectCurrentDocsContent(
        argsAfterDelegation.content,
        mode === "preview",
      );
      assertSameSnapshot(before, afterDelegation);
      if (projection !== undefined) {
        const projectedAfter = inspectCurrentDocsContent(
          inspectContentLoadedArguments(projection.args).content,
          false,
        );
        assertSameSnapshot(projection.content, projectedAfter);
        assertObjectGraphUnchanged(projection.argsObjectGraph);
      }
      await assertCurrentDocsContent.call(session, Object.freeze({
        content: afterDelegation.content,
        version: afterDelegation.version,
        docs: afterDelegation.docs,
        drafts: afterDelegation.drafts,
      }));
      const argsAfterCurrentness = inspectContentLoadedArguments(args);
      assertSameContentLoadedArguments(argsBefore, argsAfterCurrentness);
      assertSameSnapshot(
        before,
        inspectCurrentDocsContent(
          argsAfterCurrentness.content,
          mode === "preview",
        ),
      );
      if (!delegation.ok) throw delegation.error;
      return delegation.result;
    },
  };
  return Object.create(Object.getPrototypeOf(plugin), descriptors) as Plugin<unknown>;
}

export function createDocusaurusDocsAdapter(
  officialPluginModule: PluginModule<unknown>,
  createSession: CreateDocusaurusDocsAdapterSession,
): PluginModule<unknown> {
  if (typeof officialPluginModule !== "function") {
    return fail("DOCS_ADAPTER_PLUGIN_MODULE", "官方 docs plugin module 必须是 function。");
  }
  if (officialPluginModule.name !== "pluginContentDocs") {
    return fail("DOCS_ADAPTER_PLUGIN_MODULE", "官方 docs plugin module 名称发生漂移。");
  }
  if (typeof officialPluginModule.validateOptions !== "function") {
    return fail("DOCS_ADAPTER_PLUGIN_MODULE", "官方 docs plugin validateOptions 缺失。");
  }
  if (typeof createSession !== "function") {
    return fail("DOCS_ADAPTER_SESSION", "docs adapter session factory 必须是 function。");
  }

  const adapter: PluginModule<unknown> = async function axialMuseDocsAdapter(
    context,
    options,
  ) {
    const session = createSession(Object.freeze({context, options}));
    assertAdapterSession(session);
    const plugin = await officialPluginModule(context, options);
    if (plugin === null) {
      return fail(
        "DOCS_ADAPTER_PLUGIN_INSTANCE",
        "固定版本官方 docs plugin 不得自禁用。",
      );
    }
    return wrapOfficialPlugin(plugin, session);
  };
  Object.defineProperty(adapter, "validateOptions", {
    configurable: false,
    enumerable: true,
    value: officialPluginModule.validateOptions,
    writable: false,
  });
  return adapter;
}
