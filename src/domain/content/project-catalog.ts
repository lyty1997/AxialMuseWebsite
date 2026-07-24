import {classifyContentPath} from "./content-path.js";
import type {
  Author,
  PreviewImage,
  Project,
  ProjectCatalog,
  ProjectCatalogInput,
  ProjectExperience,
  ProjectSource,
  Topic,
  ValidationResult,
  WritingModule,
} from "./types.js";
import {
  arraysEqual,
  compareCodePoints,
  exactObjectKeys,
  failure,
  isDate,
  isHttpsUrl,
  isKebabId,
  isPositiveInteger,
  isRecord,
  isRepositoryRelativePath,
  isRootRelativePath,
  isSafeGitRef,
  isSingleLineText,
  isUniqueStringArray,
  isUuidV7,
  isYearMonthOrDate,
  IssueCollector,
  success,
} from "./validation.js";

const AUTHORS_PATH = "docs/contracts/authors.json";
const TOPICS_PATH = "docs/contracts/topics.json";
const PROJECTS_PATH = "docs/contracts/projects.json";
const EXPERIENCES_PATH = "docs/contracts/project-experiences.json";
const LIFECYCLE_STATUSES = ["active", "paused", "completed", "archived"] as const;
const PUBLICATION_STATUSES = ["draft", "planned", "published", "archived"] as const;
const SHOWCASE_MODES = ["repository", "repository-and-video"] as const;
const TOPIC_STATUSES = ["active", "archived"] as const;
const EXPERIENCE_STATUSES = ["planned", "provisioning", "live", "paused", "retired"] as const;
const DELIVERY_MODES = ["static"] as const;
const RESERVED_SUBDOMAINS = [
  "www",
  "api",
  "admin",
  "auth",
  "account",
  "assets",
  "cdn",
  "dev",
  "docs",
  "mail",
  "preview",
  "staging",
  "static",
  "status",
  "support",
] as const;
const DEMO_STATUSES = ["asset-pending", "review-pending", "approved"] as const;
const DNS_STATUSES = ["disabled", "pending", "active", "removed"] as const;
const EXPERIENCE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const VALIDATED_PROJECT_CATALOGS = new WeakSet<object>();

type ProjectStatus = Project["status"];
type PublicationStatus = Project["publicationStatus"];
type ShowcaseMode = Project["showcaseMode"];
type DemoStatus = NonNullable<Project["demoVideoStatus"]>;

interface IndexedValues<T> {
  readonly values: T[];
  readonly sourceIndexById: ReadonlyMap<string, number>;
}

interface IndexedProjects extends IndexedValues<Project> {
  readonly experienceRegistryIdById: ReadonlyMap<string, string>;
  readonly publicationStatusById: ReadonlyMap<string, PublicationStatus>;
}

interface IndexedExperiences extends IndexedValues<ProjectExperience> {
  readonly projectIdById: ReadonlyMap<string, string>;
}

function isExperienceId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 2
    && value.length <= 32
    && EXPERIENCE_ID_PATTERN.test(value)
    && !RESERVED_SUBDOMAINS.includes(value as typeof RESERVED_SUBDOMAINS[number]);
}

function registryRoot(
  input: unknown,
  expectedPath: string,
  allowed: readonly string[],
  collector: IssueCollector,
  subject: string,
): Record<string, unknown> | null {
  if (
    !isRecord(input)
    || typeof input.sourcePath !== "string"
    || !Object.hasOwn(input, "value")
  ) {
    collector.add(
      `CONTENT_${subject}_INPUT`,
      expectedPath,
      undefined,
      "注册表输入必须是包含 sourcePath 与 value 的 object。",
    );
    return null;
  }
  if (input.sourcePath !== expectedPath) {
    collector.add(
      `CONTENT_${subject}_PATH`,
      expectedPath,
      undefined,
      "注册表必须来自固定仓库路径。",
    );
  }
  if (!isRecord(input.value)) {
    collector.add(
      `CONTENT_${subject}_TYPE`,
      expectedPath,
      undefined,
      "注册表根必须是 JSON object。",
    );
    return null;
  }
  exactObjectKeys(
    input.value,
    allowed,
    allowed,
    collector,
    expectedPath,
    "",
    subject,
  );
  return input.value;
}

function validateFixedEnvelope(
  value: Record<string, unknown>,
  expected: Readonly<Record<string, string>>,
  collector: IssueCollector,
  sourcePath: string,
  subject: string,
): void {
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (value[field] !== expectedValue) {
      collector.add(
        `CONTENT_${subject}_ENVELOPE`,
        sourcePath,
        field,
        "注册表封套与当前 schema 版本不一致。",
      );
    }
  }
}

function validateAuthors(
  input: ProjectCatalogInput["authors"],
  collector: IssueCollector,
): Author[] {
  const root = registryRoot(
    input,
    AUTHORS_PATH,
    ["version", "kind", "status", "owner", "authors"],
    collector,
    "AUTHOR_REGISTRY",
  );
  if (root === null) return [];
  validateFixedEnvelope(root, {
    version: "0.1.0",
    kind: "axial_muse_authors",
    status: "active",
    owner: "AxialMuseWebsite",
  }, collector, AUTHORS_PATH, "AUTHOR_REGISTRY");
  if (!isRecord(root.authors)) {
    collector.add(
      "CONTENT_AUTHOR_REGISTRY_TYPE",
      AUTHORS_PATH,
      "authors",
      "authors 必须是以稳定 ID 为键的 object。",
    );
    return [];
  }

  const authors: Author[] = [];
  for (const id of Object.keys(root.authors).sort(compareCodePoints)) {
    const field = `authors.${id}`;
    if (!isKebabId(id)) {
      collector.add("CONTENT_AUTHOR_ID_INVALID", AUTHORS_PATH, field, "作者 ID 必须是 lowercase kebab-case。");
    }
    const raw = root.authors[id];
    if (!isRecord(raw)) {
      collector.add("CONTENT_AUTHOR_FIELD_INVALID", AUTHORS_PATH, field, "作者记录必须是 object。");
      continue;
    }
    exactObjectKeys(raw, ["displayName", "links"], ["displayName"], collector, AUTHORS_PATH, field, "AUTHOR");
    const displayName = raw.displayName;
    if (!isSingleLineText(displayName, 1, 80)) {
      collector.add("CONTENT_AUTHOR_FIELD_INVALID", AUTHORS_PATH, `${field}.displayName`, "作者显示名不符合长度或纯文本约束。");
    }
    let githubUrl: string | undefined;
    if (Object.hasOwn(raw, "links")) {
      if (!isRecord(raw.links)) {
        collector.add("CONTENT_AUTHOR_FIELD_INVALID", AUTHORS_PATH, `${field}.links`, "作者 links 必须是非空 object。");
      } else {
        exactObjectKeys(raw.links, ["github"], ["github"], collector, AUTHORS_PATH, `${field}.links`, "AUTHOR");
        const github = raw.links.github;
        if (
          typeof github !== "string"
          || !/^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(github)
        ) {
          collector.add("CONTENT_AUTHOR_FIELD_INVALID", AUTHORS_PATH, `${field}.links.github`, "GitHub 链接必须是账户主页 HTTPS URL。");
        } else {
          githubUrl = github;
        }
      }
    }
    if (isKebabId(id) && isSingleLineText(displayName, 1, 80)) {
      authors.push(githubUrl === undefined
        ? {id, displayName}
        : {id, displayName, githubUrl});
    }
  }
  return authors;
}

function validateTopics(
  input: ProjectCatalogInput["topics"],
  collector: IssueCollector,
): Topic[] {
  const root = registryRoot(
    input,
    TOPICS_PATH,
    ["version", "kind", "status", "owner", "topics"],
    collector,
    "TOPIC_REGISTRY",
  );
  if (root === null) return [];
  validateFixedEnvelope(root, {
    version: "0.1.0",
    kind: "axial_muse_topics",
    status: "active",
    owner: "AxialMuseWebsite",
  }, collector, TOPICS_PATH, "TOPIC_REGISTRY");
  if (!isRecord(root.topics)) {
    collector.add("CONTENT_TOPIC_REGISTRY_TYPE", TOPICS_PATH, "topics", "topics 必须是以稳定 ID 为键的 object。");
    return [];
  }
  const topics: Topic[] = [];
  const orderOwners = new Map<number, string>();
  for (const id of Object.keys(root.topics).sort(compareCodePoints)) {
    const field = `topics.${id}`;
    if (!isKebabId(id)) {
      collector.add("CONTENT_TOPIC_ID_INVALID", TOPICS_PATH, field, "主题 ID 必须是 lowercase kebab-case。");
    }
    const raw = root.topics[id];
    if (!isRecord(raw)) {
      collector.add("CONTENT_TOPIC_FIELD_INVALID", TOPICS_PATH, field, "主题记录必须是 object。");
      continue;
    }
    exactObjectKeys(raw, ["displayName", "navigationOrder", "status"], ["displayName", "navigationOrder", "status"], collector, TOPICS_PATH, field, "TOPIC");
    if (!isSingleLineText(raw.displayName, 1, 80)) {
      collector.add("CONTENT_TOPIC_FIELD_INVALID", TOPICS_PATH, `${field}.displayName`, "主题显示名不符合纯文本约束。");
    }
    if (!isPositiveInteger(raw.navigationOrder)) {
      collector.add("CONTENT_TOPIC_FIELD_INVALID", TOPICS_PATH, `${field}.navigationOrder`, "主题顺序必须是正整数。");
    } else {
      const existing = orderOwners.get(raw.navigationOrder);
      if (existing !== undefined) {
        collector.add("CONTENT_TOPIC_ORDER_DUPLICATE", TOPICS_PATH, `${field}.navigationOrder`, "主题顺序与同级条目冲突。");
        collector.add("CONTENT_TOPIC_ORDER_DUPLICATE", TOPICS_PATH, `topics.${existing}.navigationOrder`, "主题顺序与同级条目冲突。");
      } else {
        orderOwners.set(raw.navigationOrder, id);
      }
    }
    if (!TOPIC_STATUSES.includes(raw.status as typeof TOPIC_STATUSES[number])) {
      collector.add("CONTENT_TOPIC_FIELD_INVALID", TOPICS_PATH, `${field}.status`, "主题状态不属于允许枚举。");
    }
    if (
      isKebabId(id)
      && isSingleLineText(raw.displayName, 1, 80)
      && isPositiveInteger(raw.navigationOrder)
      && TOPIC_STATUSES.includes(raw.status as typeof TOPIC_STATUSES[number])
    ) {
      topics.push({
        id,
        displayName: raw.displayName,
        navigationOrder: raw.navigationOrder,
        status: raw.status as Topic["status"],
      });
    }
  }
  return topics;
}

function validateRuntimeDependencies(
  value: unknown,
  field: string,
  collector: IssueCollector,
): void {
  if (!isRecord(value)) {
    collector.add("CONTENT_EXPERIENCE_FIELD_INVALID", EXPERIENCES_PATH, field, "runtimeDependencies 必须是 object。");
    return;
  }
  const allowed = ["apiRequired", "activation", "apiHostname", "websocket", "uploads", "authentication"];
  exactObjectKeys(value, allowed, [], collector, EXPERIENCES_PATH, field, "EXPERIENCE");
  for (const booleanField of ["apiRequired", "websocket", "uploads"] as const) {
    if (Object.hasOwn(value, booleanField) && typeof value[booleanField] !== "boolean") {
      collector.add("CONTENT_EXPERIENCE_FIELD_INVALID", EXPERIENCES_PATH, `${field}.${booleanField}`, "运行依赖布尔值非法。");
    }
  }
  if (Object.hasOwn(value, "activation") && !["deferred", "active"].includes(value.activation as string)) {
    collector.add("CONTENT_EXPERIENCE_FIELD_INVALID", EXPERIENCES_PATH, `${field}.activation`, "运行依赖激活状态非法。");
  }
  for (const textField of ["apiHostname", "authentication"] as const) {
    if (Object.hasOwn(value, textField) && !isSingleLineText(value[textField], 1, 120)) {
      collector.add("CONTENT_EXPERIENCE_FIELD_INVALID", EXPERIENCES_PATH, `${field}.${textField}`, "运行依赖文本非法。");
    }
  }
}

function validateExperiences(
  input: ProjectCatalogInput["experiences"],
  collector: IssueCollector,
): IndexedExperiences {
  const allowedRoot = [
    "version", "kind", "status", "owner", "canonicalDomain",
    "defaultDeliveryMode", "defaultIndexing", "statusValues",
    "deliveryModes", "reservedSubdomains", "experiences",
  ];
  const root = registryRoot(input, EXPERIENCES_PATH, allowedRoot, collector, "EXPERIENCE_REGISTRY");
  if (root === null) {
    return {values: [], sourceIndexById: new Map(), projectIdById: new Map()};
  }
  validateFixedEnvelope(root, {
    version: "0.1.0",
    kind: "axial_muse_project_experiences",
    status: "active",
    owner: "AxialMuseWebsite",
    canonicalDomain: "axialmuse.com",
    defaultDeliveryMode: "static",
    defaultIndexing: "noindex",
  }, collector, EXPERIENCES_PATH, "EXPERIENCE_REGISTRY");
  if (!arraysEqual(root.statusValues, EXPERIENCE_STATUSES)) {
    collector.add("CONTENT_EXPERIENCE_REGISTRY_ENUM", EXPERIENCES_PATH, "statusValues", "体验状态枚举与机器契约不一致。");
  }
  if (!arraysEqual(root.deliveryModes, DELIVERY_MODES)) {
    collector.add("CONTENT_EXPERIENCE_REGISTRY_ENUM", EXPERIENCES_PATH, "deliveryModes", "体验交付模式与机器契约不一致。");
  }
  if (!arraysEqual(root.reservedSubdomains, RESERVED_SUBDOMAINS)) {
    collector.add("CONTENT_EXPERIENCE_REGISTRY_ENUM", EXPERIENCES_PATH, "reservedSubdomains", "保留子域名集合与机器契约不一致。");
  }
  if (!Array.isArray(root.experiences)) {
    collector.add("CONTENT_EXPERIENCE_REGISTRY_TYPE", EXPERIENCES_PATH, "experiences", "experiences 必须是数组。");
    return {values: [], sourceIndexById: new Map(), projectIdById: new Map()};
  }
  const experiences: ProjectExperience[] = [];
  const ids = new Map<string, number>();
  const projectIdById = new Map<string, string>();
  const hostnames = new Map<string, number>();
  const fields = [
    "id", "projectId", "hostname", "status", "dnsProvisioning", "deliveryMode",
    "deploymentSource", "qualityCommands", "buildCommand", "artifactDirectory",
    "healthPath", "indexing", "dataBoundary", "owner", "runtimeDependencies",
  ];
  for (const [index, raw] of root.experiences.entries()) {
    const field = `experiences.${index}`;
    if (!isRecord(raw)) {
      collector.add("CONTENT_EXPERIENCE_FIELD_INVALID", EXPERIENCES_PATH, field, "体验记录必须是 object。");
      continue;
    }
    exactObjectKeys(raw, fields, fields.filter((name) => name !== "runtimeDependencies"), collector, EXPERIENCES_PATH, field, "EXPERIENCE");
    const id = raw.id;
    const projectId = raw.projectId;
    const hostname = raw.hostname;
    const status = raw.status;
    const dnsProvisioning = raw.dnsProvisioning;
    const deliveryMode = raw.deliveryMode;
    const indexing = raw.indexing;
    const healthPath = raw.healthPath;
    if (!isExperienceId(id)) collector.add("CONTENT_EXPERIENCE_FIELD_INVALID", EXPERIENCES_PATH, `${field}.id`, "体验 ID 必须是非保留的项目子域 slug。");
    if (!isKebabId(projectId)) collector.add("CONTENT_EXPERIENCE_FIELD_INVALID", EXPERIENCES_PATH, `${field}.projectId`, "体验项目外键非法。");
    if (typeof id === "string" && typeof projectId === "string" && id !== projectId) {
      collector.add("CONTENT_EXPERIENCE_PROJECT_MISMATCH", EXPERIENCES_PATH, `${field}.projectId`, "体验 ID 必须与项目稳定 ID 一致。");
    }
    if (typeof hostname !== "string" || hostname !== `${String(id)}.axialmuse.com`) {
      collector.add("CONTENT_EXPERIENCE_FIELD_INVALID", EXPERIENCES_PATH, `${field}.hostname`, "体验 hostname 必须由体验 ID 与 canonical domain 精确形成。");
    }
    if (!EXPERIENCE_STATUSES.includes(status as ProjectExperience["status"])) {
      collector.add("CONTENT_EXPERIENCE_FIELD_INVALID", EXPERIENCES_PATH, `${field}.status`, "体验状态非法。");
    }
    if (!DNS_STATUSES.includes(dnsProvisioning as ProjectExperience["dnsProvisioning"])) {
      collector.add("CONTENT_EXPERIENCE_FIELD_INVALID", EXPERIENCES_PATH, `${field}.dnsProvisioning`, "DNS 实施状态非法。");
    }
    if (deliveryMode !== "static") {
      collector.add("CONTENT_EXPERIENCE_FIELD_INVALID", EXPERIENCES_PATH, `${field}.deliveryMode`, "M0 体验交付模式必须是 static。");
    }
    if (!(["noindex", "index"] as const).includes(indexing as ProjectExperience["indexing"])) {
      collector.add("CONTENT_EXPERIENCE_FIELD_INVALID", EXPERIENCES_PATH, `${field}.indexing`, "体验索引状态非法。");
    }
    if (typeof healthPath !== "string" || !/^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*$/u.test(healthPath)) {
      collector.add("CONTENT_EXPERIENCE_FIELD_INVALID", EXPERIENCES_PATH, `${field}.healthPath`, "健康检查路径必须是规范根相对路径。");
    }
    if (status === "planned" && dnsProvisioning !== "disabled") {
      collector.add("CONTENT_EXPERIENCE_STATE_INVALID", EXPERIENCES_PATH, `${field}.dnsProvisioning`, "planned 体验必须保持 DNS disabled。");
    }
    if (status === "live" && dnsProvisioning !== "active") {
      collector.add("CONTENT_EXPERIENCE_STATE_INVALID", EXPERIENCES_PATH, `${field}.dnsProvisioning`, "live 体验必须具有 active DNS 状态。");
    }
    if (isExperienceId(id)) {
      const previous = ids.get(id);
      if (previous !== undefined) {
        collector.add("CONTENT_EXPERIENCE_ID_DUPLICATE", EXPERIENCES_PATH, `${field}.id`, "体验 ID 重复。");
        collector.add("CONTENT_EXPERIENCE_ID_DUPLICATE", EXPERIENCES_PATH, `experiences.${previous}.id`, "体验 ID 重复。");
      } else {
        ids.set(id, index);
        if (isKebabId(projectId)) projectIdById.set(id, projectId);
      }
    }
    if (typeof hostname === "string") {
      const previous = hostnames.get(hostname);
      if (previous !== undefined) {
        collector.add("CONTENT_EXPERIENCE_HOST_DUPLICATE", EXPERIENCES_PATH, `${field}.hostname`, "体验 hostname 重复。");
        collector.add("CONTENT_EXPERIENCE_HOST_DUPLICATE", EXPERIENCES_PATH, `experiences.${previous}.hostname`, "体验 hostname 重复。");
      } else hostnames.set(hostname, index);
    }
    if (!isRecord(raw.deploymentSource)) {
      collector.add("CONTENT_EXPERIENCE_FIELD_INVALID", EXPERIENCES_PATH, `${field}.deploymentSource`, "deploymentSource 必须是 object。");
    } else {
      exactObjectKeys(raw.deploymentSource, ["kind", "workingDirectory"], ["kind", "workingDirectory"], collector, EXPERIENCES_PATH, `${field}.deploymentSource`, "EXPERIENCE");
      if (raw.deploymentSource.kind !== "project-repository" || !isRepositoryRelativePath(raw.deploymentSource.workingDirectory)) {
        collector.add("CONTENT_EXPERIENCE_FIELD_INVALID", EXPERIENCES_PATH, `${field}.deploymentSource`, "部署源码职责或工作目录非法。");
      }
    }
    if (
      !Array.isArray(raw.qualityCommands)
      || raw.qualityCommands.length < 1
      || raw.qualityCommands.length > 20
      || raw.qualityCommands.some((command) => !isSingleLineText(command, 1, 300))
    ) {
      collector.add("CONTENT_EXPERIENCE_FIELD_INVALID", EXPERIENCES_PATH, `${field}.qualityCommands`, "质量命令必须是非空单行字符串数组。");
    }
    for (const name of ["buildCommand", "owner"] as const) {
      if (!isSingleLineText(raw[name], 1, name === "owner" ? 80 : 300)) {
        collector.add("CONTENT_EXPERIENCE_FIELD_INVALID", EXPERIENCES_PATH, `${field}.${name}`, "体验文本字段非法。");
      }
    }
    for (const name of ["artifactDirectory", "dataBoundary"] as const) {
      if (!isRepositoryRelativePath(raw[name])) {
        collector.add("CONTENT_EXPERIENCE_FIELD_INVALID", EXPERIENCES_PATH, `${field}.${name}`, "体验仓库相对路径非法。");
      }
    }
    if (Object.hasOwn(raw, "runtimeDependencies")) {
      validateRuntimeDependencies(raw.runtimeDependencies, `${field}.runtimeDependencies`, collector);
    }
    if (
      isExperienceId(id)
      && isKebabId(projectId)
      && typeof hostname === "string"
      && EXPERIENCE_STATUSES.includes(status as ProjectExperience["status"])
      && DNS_STATUSES.includes(dnsProvisioning as ProjectExperience["dnsProvisioning"])
      && deliveryMode === "static"
      && (["noindex", "index"] as const).includes(indexing as ProjectExperience["indexing"])
      && typeof healthPath === "string"
    ) {
      experiences.push({
        id,
        projectId,
        hostname,
        status: status as ProjectExperience["status"],
        dnsProvisioning: dnsProvisioning as ProjectExperience["dnsProvisioning"],
        deliveryMode: "static",
        indexing: indexing as ProjectExperience["indexing"],
        healthPath,
      });
    }
  }
  return {
    values: experiences.sort((left, right) => compareCodePoints(left.id, right.id)),
    sourceIndexById: ids,
    projectIdById,
  };
}

function validateModules(
  value: unknown,
  field: string,
  collector: IssueCollector,
): WritingModule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, field, "writingModules 必须是数组。");
    return [];
  }
  const modules: WritingModule[] = [];
  const ids = new Map<string, number>();
  const orders = new Map<number, number>();
  for (const [index, raw] of value.entries()) {
    const itemField = `${field}.${index}`;
    if (!isRecord(raw)) {
      collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, itemField, "模块必须是 object。");
      continue;
    }
    exactObjectKeys(raw, ["id", "displayName", "navigationOrder", "status"], ["id", "displayName", "navigationOrder", "status"], collector, PROJECTS_PATH, itemField, "PROJECT");
    if (!isKebabId(raw.id)) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${itemField}.id`, "模块 ID 非法。");
    if (!isSingleLineText(raw.displayName, 1, 80)) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${itemField}.displayName`, "模块显示名非法。");
    if (!isPositiveInteger(raw.navigationOrder)) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${itemField}.navigationOrder`, "模块顺序必须是正整数。");
    if (!TOPIC_STATUSES.includes(raw.status as WritingModule["status"])) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${itemField}.status`, "模块状态非法。");
    if (isKebabId(raw.id)) {
      const previous = ids.get(raw.id);
      if (previous !== undefined) {
        collector.add("CONTENT_PROJECT_MODULE_DUPLICATE", PROJECTS_PATH, `${itemField}.id`, "同一项目的模块 ID 重复。");
        collector.add("CONTENT_PROJECT_MODULE_DUPLICATE", PROJECTS_PATH, `${field}.${previous}.id`, "同一项目的模块 ID 重复。");
      } else ids.set(raw.id, index);
    }
    if (isPositiveInteger(raw.navigationOrder)) {
      const previous = orders.get(raw.navigationOrder);
      if (previous !== undefined) {
        collector.add("CONTENT_PROJECT_MODULE_ORDER_DUPLICATE", PROJECTS_PATH, `${itemField}.navigationOrder`, "同一项目的模块顺序冲突。");
        collector.add("CONTENT_PROJECT_MODULE_ORDER_DUPLICATE", PROJECTS_PATH, `${field}.${previous}.navigationOrder`, "同一项目的模块顺序冲突。");
      } else orders.set(raw.navigationOrder, index);
    }
    if (
      isKebabId(raw.id)
      && isSingleLineText(raw.displayName, 1, 80)
      && isPositiveInteger(raw.navigationOrder)
      && TOPIC_STATUSES.includes(raw.status as WritingModule["status"])
    ) {
      modules.push({
        id: raw.id,
        displayName: raw.displayName,
        navigationOrder: raw.navigationOrder,
        status: raw.status as WritingModule["status"],
      });
    }
  }
  return modules.sort((left, right) => compareCodePoints(left.id, right.id));
}

function validatePreview(
  value: unknown,
  projectId: string,
  title: unknown,
  summary: unknown,
  field: string,
  collector: IssueCollector,
): PreviewImage | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    collector.add("CONTENT_PROJECT_PREVIEW_INVALID", PROJECTS_PATH, field, "previewImage 必须是单一 object。");
    return undefined;
  }
  exactObjectKeys(value, ["sourcePath", "width", "height", "alt"], ["sourcePath", "width", "height", "alt"], collector, PROJECTS_PATH, field, "PROJECT");
  const expectedPattern = new RegExp(`^projects/${projectId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/[a-z0-9]+(?:-[a-z0-9]+)*\\.webp$`, "u");
  if (typeof value.sourcePath !== "string" || !expectedPattern.test(value.sourcePath)) {
    collector.add("CONTENT_PROJECT_PREVIEW_PATH", PROJECTS_PATH, `${field}.sourcePath`, "主预览路径必须绑定当前项目且为 lowercase WebP 路径。");
  }
  if (value.width !== 1600 || value.height !== 1000) {
    collector.add("CONTENT_PROJECT_PREVIEW_DIMENSIONS", PROJECTS_PATH, `${field}.width`, "主预览登记尺寸必须是 1600 x 1000。");
  }
  if (
    !isSingleLineText(value.alt, 1, 160)
    || value.alt === title
    || value.alt === summary
  ) {
    collector.add("CONTENT_PROJECT_PREVIEW_ALT", PROJECTS_PATH, `${field}.alt`, "主预览替代文本不符合约束或复述标题/摘要。");
  }
  if (
    typeof value.sourcePath === "string"
    && expectedPattern.test(value.sourcePath)
    && value.width === 1600
    && value.height === 1000
    && isSingleLineText(value.alt, 1, 160)
    && value.alt !== title
    && value.alt !== summary
  ) {
    return {sourcePath: value.sourcePath, width: 1600, height: 1000, alt: value.alt};
  }
  return undefined;
}

function validateStringSources(value: unknown, field: string, collector: IssueCollector): string[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > 10
    || value.some((entry) => typeof entry !== "string")
  ) {
    collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, field, "source 必须是 1-10 个字符串。");
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!isHttpsUrl(entry) && !isRepositoryRelativePath(entry)) {
      collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${field}.${index}`, "source 必须是 HTTPS URL 或安全仓库相对路径。");
    }
    if (seen.has(entry)) {
      collector.add("CONTENT_PROJECT_FIELD_DUPLICATE", PROJECTS_PATH, `${field}.${index}`, "source 条目重复。");
    }
    seen.add(entry);
    if ((isHttpsUrl(entry) || isRepositoryRelativePath(entry)) && !result.includes(entry)) result.push(entry);
  }
  return result;
}

function validateProjects(
  input: ProjectCatalogInput["projects"],
  collector: IssueCollector,
): IndexedProjects {
  const allowedRoot = [
    "version", "kind", "status", "owner", "lifecycleStatusValues",
    "publicationStatusValues", "showcaseModes", "projects",
  ];
  const root = registryRoot(input, PROJECTS_PATH, allowedRoot, collector, "PROJECT_REGISTRY");
  if (root === null) {
    return {
      values: [],
      sourceIndexById: new Map(),
      experienceRegistryIdById: new Map(),
      publicationStatusById: new Map(),
    };
  }
  validateFixedEnvelope(root, {
    version: "0.3.0",
    kind: "axial_muse_projects",
    status: "active",
    owner: "AxialMuseWebsite",
  }, collector, PROJECTS_PATH, "PROJECT_REGISTRY");
  if (!arraysEqual(root.lifecycleStatusValues, LIFECYCLE_STATUSES)) collector.add("CONTENT_PROJECT_REGISTRY_ENUM", PROJECTS_PATH, "lifecycleStatusValues", "项目生命周期枚举漂移。");
  if (!arraysEqual(root.publicationStatusValues, PUBLICATION_STATUSES)) collector.add("CONTENT_PROJECT_REGISTRY_ENUM", PROJECTS_PATH, "publicationStatusValues", "项目发布状态枚举漂移。");
  if (!arraysEqual(root.showcaseModes, SHOWCASE_MODES)) collector.add("CONTENT_PROJECT_REGISTRY_ENUM", PROJECTS_PATH, "showcaseModes", "项目展示模式枚举漂移。");
  if (!Array.isArray(root.projects)) {
    collector.add("CONTENT_PROJECT_REGISTRY_TYPE", PROJECTS_PATH, "projects", "projects 必须是数组。");
    return {
      values: [],
      sourceIndexById: new Map(),
      experienceRegistryIdById: new Map(),
      publicationStatusById: new Map(),
    };
  }
  const allowed = [
    "id", "title", "slug", "navigationOrder", "summary", "status",
    "publicationStatus", "startedAt", "updatedAt", "repositoryUrl",
    "productionBranch", "showcaseMode", "demoVideoStatus", "experienceRegistryId",
    "demoVideoUrl", "demoVideoPoster", "demoVideoCaptions", "relatedWriting",
    "writingModules", "previewImage", "source",
  ];
  const required = [
    "id", "title", "slug", "navigationOrder", "summary", "status",
    "publicationStatus", "startedAt", "updatedAt", "showcaseMode", "source",
  ];
  const projects: Project[] = [];
  const ids = new Map<string, number>();
  const experienceRegistryIdById = new Map<string, string>();
  const publicationStatusById = new Map<string, PublicationStatus>();
  const slugs = new Map<string, number>();
  const orders = new Map<number, number>();
  for (const [index, raw] of root.projects.entries()) {
    const field = `projects.${index}`;
    if (!isRecord(raw)) {
      collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, field, "项目记录必须是 object。");
      continue;
    }
    exactObjectKeys(raw, allowed, required, collector, PROJECTS_PATH, field, "PROJECT");
    if (!isKebabId(raw.id)) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${field}.id`, "项目 ID 非法。");
    if (!isSingleLineText(raw.title, 1, 100)) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${field}.title`, "项目标题不符合纯文本约束。");
    if (!isKebabId(raw.slug)) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${field}.slug`, "项目 slug 非法。");
    if (!isPositiveInteger(raw.navigationOrder)) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${field}.navigationOrder`, "项目顺序必须是正整数。");
    if (!isSingleLineText(raw.summary, 20, 200)) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${field}.summary`, "项目摘要长度或纯文本形态非法。");
    if (!LIFECYCLE_STATUSES.includes(raw.status as ProjectStatus)) collector.add("CONTENT_PROJECT_STATE_INVALID", PROJECTS_PATH, `${field}.status`, "项目生命周期状态非法。");
    if (!PUBLICATION_STATUSES.includes(raw.publicationStatus as PublicationStatus)) collector.add("CONTENT_PROJECT_STATE_INVALID", PROJECTS_PATH, `${field}.publicationStatus`, "项目发布状态非法。");
    if (!isYearMonthOrDate(raw.startedAt)) collector.add("CONTENT_PROJECT_DATE_INVALID", PROJECTS_PATH, `${field}.startedAt`, "项目开始日期非法。");
    if (!isDate(raw.updatedAt)) collector.add("CONTENT_PROJECT_DATE_INVALID", PROJECTS_PATH, `${field}.updatedAt`, "项目更新日期非法。");
    if (isYearMonthOrDate(raw.startedAt) && isDate(raw.updatedAt) && raw.updatedAt.slice(0, raw.startedAt.length) < raw.startedAt) {
      collector.add("CONTENT_PROJECT_DATE_ORDER", PROJECTS_PATH, `${field}.updatedAt`, "项目更新日期早于开始日期。");
    }
    if (!SHOWCASE_MODES.includes(raw.showcaseMode as ShowcaseMode)) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${field}.showcaseMode`, "项目展示模式非法。");
    if (raw.repositoryUrl !== undefined && !isHttpsUrl(raw.repositoryUrl, false)) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${field}.repositoryUrl`, "项目仓库必须是无凭据、query 或 fragment 的 HTTPS URL。");
    if (raw.repositoryUrl !== undefined && !isSafeGitRef(raw.productionBranch)) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${field}.productionBranch`, "公开仓库必须同时登记安全生产分支。");
    if (raw.repositoryUrl === undefined && raw.productionBranch !== undefined) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${field}.productionBranch`, "没有仓库时不得单独登记生产分支。");
    if (SHOWCASE_MODES.includes(raw.showcaseMode as ShowcaseMode) && raw.repositoryUrl === undefined) collector.add("CONTENT_PROJECT_FIELD_REQUIRED", PROJECTS_PATH, `${field}.repositoryUrl`, "当前展示模式要求公开仓库。");
    if (raw.demoVideoStatus !== undefined && !DEMO_STATUSES.includes(raw.demoVideoStatus as DemoStatus)) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${field}.demoVideoStatus`, "演示视频状态非法。");
    const videoFields = [raw.demoVideoUrl, raw.demoVideoPoster, raw.demoVideoCaptions];
    const videoCount = videoFields.filter((value) => value !== undefined).length;
    if (videoCount !== 0 && videoCount !== 3) collector.add("CONTENT_PROJECT_VIDEO_INCOMPLETE", PROJECTS_PATH, `${field}.demoVideoUrl`, "演示视频 URL、封面与字幕必须成组出现。");
    if (videoCount === 3) {
      if (raw.demoVideoStatus !== "approved" || raw.showcaseMode !== "repository-and-video") collector.add("CONTENT_PROJECT_VIDEO_STATE", PROJECTS_PATH, `${field}.demoVideoStatus`, "已登记视频文件必须经过批准并启用视频展示模式。");
      if (!isHttpsUrl(raw.demoVideoUrl) && !isRootRelativePath(raw.demoVideoUrl)) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${field}.demoVideoUrl`, "演示视频 URL 非法。");
      if (!isRootRelativePath(raw.demoVideoPoster)) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${field}.demoVideoPoster`, "视频封面必须是站内根相对路径。");
      if (!isRootRelativePath(raw.demoVideoCaptions, ".vtt")) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${field}.demoVideoCaptions`, "视频字幕必须是站内 UTF-8 WebVTT 路径。");
    }
    if (
      raw.demoVideoStatus === "approved"
      && (videoCount !== 3 || raw.showcaseMode !== "repository-and-video")
    ) {
      collector.add("CONTENT_PROJECT_VIDEO_STATE", PROJECTS_PATH, `${field}.demoVideoStatus`, "approved 视频状态要求完整三件套与视频展示模式。");
    }
    if (raw.showcaseMode === "repository-and-video" && videoCount !== 3) collector.add("CONTENT_PROJECT_VIDEO_INCOMPLETE", PROJECTS_PATH, `${field}.showcaseMode`, "视频展示模式要求完整且已审核的视频三件套。");
    if (raw.experienceRegistryId !== undefined && !isExperienceId(raw.experienceRegistryId)) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${field}.experienceRegistryId`, "体验注册表 ID 必须是非保留的项目子域 slug。");
    const relatedWriting = raw.relatedWriting === undefined
      ? []
      : isUniqueStringArray(raw.relatedWriting, 1, 10, isUuidV7)
        ? [...raw.relatedWriting]
        : [];
    if (raw.relatedWriting !== undefined && relatedWriting.length === 0) collector.add("CONTENT_PROJECT_FIELD_INVALID", PROJECTS_PATH, `${field}.relatedWriting`, "relatedWriting 必须是 1-10 个不重复 UUIDv7。");
    const writingModules = validateModules(raw.writingModules, `${field}.writingModules`, collector);
    const previewImage = validatePreview(raw.previewImage, typeof raw.id === "string" ? raw.id : "invalid", raw.title, raw.summary, `${field}.previewImage`, collector);
    if (["published", "archived"].includes(raw.publicationStatus as string) && previewImage === undefined) collector.add("CONTENT_PROJECT_PREVIEW_REQUIRED", PROJECTS_PATH, `${field}.previewImage`, "公开项目必须登记唯一主预览。");
    const source = validateStringSources(raw.source, `${field}.source`, collector);
    if (isKebabId(raw.id)) {
      const previous = ids.get(raw.id);
      if (previous !== undefined) {
        collector.add("CONTENT_PROJECT_ID_DUPLICATE", PROJECTS_PATH, `${field}.id`, "项目 ID 重复。");
        collector.add("CONTENT_PROJECT_ID_DUPLICATE", PROJECTS_PATH, `projects.${previous}.id`, "项目 ID 重复。");
      } else {
        ids.set(raw.id, index);
        if (isExperienceId(raw.experienceRegistryId)) {
          experienceRegistryIdById.set(raw.id, raw.experienceRegistryId);
        }
        if (PUBLICATION_STATUSES.includes(raw.publicationStatus as PublicationStatus)) {
          publicationStatusById.set(raw.id, raw.publicationStatus as PublicationStatus);
        }
      }
    }
    if (isKebabId(raw.slug)) {
      const previous = slugs.get(raw.slug);
      if (previous !== undefined) {
        collector.add("CONTENT_PROJECT_SLUG_DUPLICATE", PROJECTS_PATH, `${field}.slug`, "项目 slug 重复。");
        collector.add("CONTENT_PROJECT_SLUG_DUPLICATE", PROJECTS_PATH, `projects.${previous}.slug`, "项目 slug 重复。");
      } else slugs.set(raw.slug, index);
    }
    if (isPositiveInteger(raw.navigationOrder)) {
      const previous = orders.get(raw.navigationOrder);
      if (previous !== undefined) {
        collector.add("CONTENT_PROJECT_ORDER_DUPLICATE", PROJECTS_PATH, `${field}.navigationOrder`, "项目顺序冲突。");
        collector.add("CONTENT_PROJECT_ORDER_DUPLICATE", PROJECTS_PATH, `projects.${previous}.navigationOrder`, "项目顺序冲突。");
      } else orders.set(raw.navigationOrder, index);
    }
    if (
      isKebabId(raw.id)
      && isSingleLineText(raw.title, 1, 100)
      && isKebabId(raw.slug)
      && isPositiveInteger(raw.navigationOrder)
      && isSingleLineText(raw.summary, 20, 200)
      && LIFECYCLE_STATUSES.includes(raw.status as ProjectStatus)
      && PUBLICATION_STATUSES.includes(raw.publicationStatus as PublicationStatus)
      && isYearMonthOrDate(raw.startedAt)
      && isDate(raw.updatedAt)
      && SHOWCASE_MODES.includes(raw.showcaseMode as ShowcaseMode)
      && source.length > 0
    ) {
      projects.push({
        id: raw.id,
        title: raw.title,
        slug: raw.slug,
        navigationOrder: raw.navigationOrder,
        summary: raw.summary,
        status: raw.status as ProjectStatus,
        publicationStatus: raw.publicationStatus as PublicationStatus,
        startedAt: raw.startedAt,
        updatedAt: raw.updatedAt,
        ...(typeof raw.repositoryUrl === "string" ? {repositoryUrl: raw.repositoryUrl} : {}),
        ...(typeof raw.productionBranch === "string" ? {productionBranch: raw.productionBranch} : {}),
        showcaseMode: raw.showcaseMode as ShowcaseMode,
        ...(DEMO_STATUSES.includes(raw.demoVideoStatus as DemoStatus) ? {demoVideoStatus: raw.demoVideoStatus as DemoStatus} : {}),
        ...(typeof raw.experienceRegistryId === "string" ? {experienceRegistryId: raw.experienceRegistryId} : {}),
        ...(typeof raw.demoVideoUrl === "string" ? {demoVideoUrl: raw.demoVideoUrl} : {}),
        ...(typeof raw.demoVideoPoster === "string" ? {demoVideoPoster: raw.demoVideoPoster} : {}),
        ...(typeof raw.demoVideoCaptions === "string" ? {demoVideoCaptions: raw.demoVideoCaptions} : {}),
        relatedWriting,
        writingModules,
        ...(previewImage === undefined ? {} : {previewImage}),
        source,
      });
    }
  }
  return {
    values: projects.sort((left, right) => compareCodePoints(left.id, right.id)),
    sourceIndexById: ids,
    experienceRegistryIdById,
    publicationStatusById,
  };
}

interface FenceRun {
  readonly marker: "`" | "~";
  readonly length: number;
  readonly remainder: string;
}

type MarkdownContainerOwner =
  | Readonly<{kind: "quote"}>
  | Readonly<{kind: "list"; indent: number}>;

interface MarkdownContainerLine {
  readonly content: string;
  readonly owners: readonly MarkdownContainerOwner[];
  readonly startsListItem: boolean;
}

function stripMarkdownContainerPrefixes(line: string): MarkdownContainerLine {
  let offset = 0;
  const owners: MarkdownContainerOwner[] = [];
  let startsListItem = false;
  while (offset < line.length) {
    let markerStart = offset;
    while (markerStart - offset < 3 && line[markerStart] === " ") markerStart += 1;
    if (line[markerStart] === ">") {
      offset = markerStart + 1;
      if (line[offset] === " " || line[offset] === "\t") offset += 1;
      owners.push({kind: "quote"});
      continue;
    }
    let markerEnd = markerStart;
    if (["-", "+", "*"].includes(line[markerStart] ?? "")) {
      markerEnd += 1;
    } else {
      let digitEnd = markerStart;
      while (digitEnd - markerStart < 9 && /\d/u.test(line[digitEnd] ?? "")) {
        digitEnd += 1;
      }
      if (
        digitEnd === markerStart
        || (line[digitEnd] !== "." && line[digitEnd] !== ")")
      ) break;
      markerEnd = digitEnd + 1;
    }
    if (markerEnd === line.length) {
      owners.push({kind: "list", indent: markerEnd - offset});
      offset = markerEnd;
      startsListItem = true;
      break;
    }
    if (line[markerEnd] !== " " && line[markerEnd] !== "\t") break;
    let whitespaceEnd = markerEnd;
    while (line[whitespaceEnd] === " " || line[whitespaceEnd] === "\t") {
      whitespaceEnd += 1;
    }
    const whitespaceLength = whitespaceEnd - markerEnd;
    const consumedWhitespace = whitespaceLength <= 4 ? whitespaceLength : 1;
    const nextOffset = markerEnd + consumedWhitespace;
    owners.push({kind: "list", indent: nextOffset - offset});
    offset = nextOffset;
    startsListItem = true;
  }
  return {
    content: line.slice(offset),
    owners,
    startsListItem,
  };
}

function readFenceRun(line: string): FenceRun | undefined {
  let markerStart = 0;
  while (markerStart < 3 && line[markerStart] === " ") markerStart += 1;
  const marker = line[markerStart];
  if (marker !== "`" && marker !== "~") return undefined;
  let markerEnd = markerStart;
  while (line[markerEnd] === marker) markerEnd += 1;
  if (markerEnd - markerStart < 3) return undefined;
  return {
    marker,
    length: markerEnd - markerStart,
    remainder: line.slice(markerEnd),
  };
}

function stripRequiredIndent(line: string, requiredColumns: number): string | undefined {
  let columns = 0;
  let index = 0;
  while (columns < requiredColumns && index < line.length) {
    if (line[index] === " ") {
      columns += 1;
    } else if (line[index] === "\t") {
      columns += 4 - (columns % 4);
    } else {
      return undefined;
    }
    index += 1;
  }
  return columns >= requiredColumns ? line.slice(index) : undefined;
}

function stripOwnedContainerLine(
  line: string,
  owners: readonly MarkdownContainerOwner[],
): string | undefined {
  let content = line;
  for (const owner of owners) {
    if (owner.kind === "list") {
      if (content.trim() === "") return "";
      const stripped = stripRequiredIndent(content, owner.indent);
      if (stripped === undefined) return undefined;
      content = stripped;
      continue;
    }
    let marker = 0;
    while (marker < 3 && content[marker] === " ") marker += 1;
    if (content[marker] !== ">") return undefined;
    let offset = marker + 1;
    if (content[offset] === " " || content[offset] === "\t") offset += 1;
    content = content.slice(offset);
  }
  return content;
}

function containsInlineNativeH1(content: string): boolean {
  const runs: Array<Readonly<{start: number; end: number; length: number}>> = [];
  for (let index = 0; index < content.length;) {
    if (content[index] !== "`") {
      index += 1;
      continue;
    }
    let runEnd = index + 1;
    while (content[runEnd] === "`") runEnd += 1;
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && content[cursor] === "\\"; cursor -= 1) {
      backslashes += 1;
    }
    const escapedPrefix = backslashes % 2;
    if (runEnd - index > escapedPrefix) {
      runs.push({
        start: index + escapedPrefix,
        end: runEnd,
        length: runEnd - index - escapedPrefix,
      });
    }
    index = runEnd;
  }

  const nextSameLength = new Array<number | undefined>(runs.length);
  const nextByLength = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    nextSameLength[index] = nextByLength.get(run.length);
    nextByLength.set(run.length, index);
  }

  let index = 0;
  let runIndex = 0;
  let precedingBackslashes = 0;
  while (index < content.length) {
    while (runIndex < runs.length && runs[runIndex].start < index) runIndex += 1;
    const run = runs[runIndex];
    if (run?.start === index) {
      const closingRunIndex = nextSameLength[runIndex];
      if (closingRunIndex !== undefined) {
        index = runs[closingRunIndex].end;
        runIndex = closingRunIndex + 1;
      } else {
        index = run.end;
        runIndex += 1;
      }
      precedingBackslashes = 0;
      continue;
    }
    if (content.startsWith("<!--", index)) {
      const commentEnd = content.indexOf("-->", index + 4);
      if (commentEnd === -1) {
        index += 4;
        precedingBackslashes = 0;
        continue;
      }
      index = commentEnd + 3;
      precedingBackslashes = 0;
      continue;
    }
    const nextCharacter = content[index + 3];
    if (
      content[index] === "<"
      && precedingBackslashes % 2 === 0
      && content[index + 1]?.toLowerCase() === "h"
      && content[index + 2] === "1"
      && (nextCharacter === undefined || /[\t />]/u.test(nextCharacter))
    ) return true;
    const character = content[index] ?? "";
    precedingBackslashes = character === "\\" ? precedingBackslashes + 1 : 0;
    index += 1;
  }
  return false;
}

function ownerIdentity(owners: readonly MarkdownContainerOwner[]): string {
  return owners.map((owner) => (
    owner.kind === "quote" ? "q" : `l${owner.indent}`
  )).join("/");
}

function canPrecedeSetextH1(line: string): boolean {
  if (line.trim() === "" || /^(?: {4}|\t)/u.test(line)) return false;
  if (/^ {0,3}#{1,6}(?:[\t ]|$)/u.test(line)) return false;
  if (/^ {0,3}(?:>|(?:[-+*]|\d{1,9}[.)])[\t ])/u.test(line)) return false;
  if (/^ {0,3}\[[^\]]+\]:/u.test(line)) return false;
  return !/^ {0,3}(?:(?:\*[\t ]*){3,}|(?:_[\t ]*){3,}|(?:-[\t ]*){3,})$/u.test(line);
}

function containsProjectH1(content: string): boolean {
  const lines = content
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  let fence: {
    marker: "`" | "~";
    length: number;
    owners: readonly MarkdownContainerOwner[];
  } | undefined;
  let blockCommentOwners: readonly MarkdownContainerOwner[] | undefined;
  let activeListOwners: readonly MarkdownContainerOwner[] | undefined;
  let inlineContext = "";
  let inlineLines: string[] = [];
  let previousCanBeSetext = false;
  let previousContext = "";
  const flushInline = (): boolean => {
    const hasH1 = inlineLines.length > 0
      && containsInlineNativeH1(inlineLines.join("\n"));
    inlineLines = [];
    return hasH1;
  };
  for (const line of lines) {
    if (fence !== undefined) {
      const ownedLine = stripOwnedContainerLine(line, fence.owners);
      if (ownedLine !== undefined) {
        const closingFence = readFenceRun(ownedLine);
        if (
          closingFence !== undefined
          && fence.marker === closingFence.marker
          && closingFence.length >= fence.length
          && closingFence.remainder.trim() === ""
        ) {
          fence = undefined;
        }
        previousCanBeSetext = false;
        continue;
      }
      fence = undefined;
    }

    if (blockCommentOwners !== undefined) {
      const ownedLine = stripOwnedContainerLine(line, blockCommentOwners);
      if (ownedLine !== undefined) {
        if (ownedLine.includes("-->")) blockCommentOwners = undefined;
        previousCanBeSetext = false;
        continue;
      }
      blockCommentOwners = undefined;
    }

    let baseOwners: readonly MarkdownContainerOwner[] = [];
    let candidateLine = line;
    if (activeListOwners !== undefined) {
      const continuation = stripOwnedContainerLine(line, activeListOwners);
      if (continuation !== undefined) {
        baseOwners = activeListOwners;
        candidateLine = continuation;
      } else {
        activeListOwners = undefined;
      }
    }
    const containerLine = stripMarkdownContainerPrefixes(candidateLine);
    const owners = [...baseOwners, ...containerLine.owners];
    let lastListOwner = -1;
    for (let ownerIndex = owners.length - 1; ownerIndex >= 0; ownerIndex -= 1) {
      if (owners[ownerIndex].kind === "list") {
        lastListOwner = ownerIndex;
        break;
      }
    }
    if (containerLine.startsListItem && lastListOwner >= 0) {
      activeListOwners = owners.slice(0, lastListOwner + 1);
    } else if (baseOwners.length === 0) {
      activeListOwners = undefined;
    }
    const markdownLine = containerLine.content;
    const context = ownerIdentity(owners);
    if (inlineLines.length > 0 && context !== inlineContext) {
      if (flushInline()) return true;
    }
    inlineContext = context;

    if (markdownLine.trim() === "") {
      if (flushInline()) return true;
      previousCanBeSetext = false;
      continue;
    }

    const fenceRun = readFenceRun(markdownLine);
    if (
      fenceRun !== undefined
      && (fenceRun.marker === "~" || !fenceRun.remainder.includes("`"))
    ) {
      if (flushInline()) return true;
      fence = {
        marker: fenceRun.marker,
        length: fenceRun.length,
        owners,
      };
      previousCanBeSetext = false;
      continue;
    }

    if (/^ {0,3}<!--/u.test(markdownLine)) {
      if (flushInline()) return true;
      if (!markdownLine.includes("-->")) blockCommentOwners = owners;
      previousCanBeSetext = false;
      continue;
    }

    if (/^ {0,3}#(?:[\t ]|$)/u.test(markdownLine)) return true;
    if (
      previousCanBeSetext
      && !containerLine.startsListItem
      && context === previousContext
      && /^ {0,3}=+[ \t]*$/u.test(markdownLine)
    ) return true;
    if (/^(?: {4}|\t)/u.test(markdownLine)) {
      if (inlineLines.length > 0 && context === inlineContext) {
        inlineLines.push(markdownLine);
        previousCanBeSetext = canPrecedeSetextH1(markdownLine);
        previousContext = context;
        continue;
      }
      if (flushInline()) return true;
      previousCanBeSetext = false;
      previousContext = context;
      continue;
    }
    if (/^ {0,3}<h1(?:[\t />]|$)/iu.test(markdownLine)) return true;
    inlineLines.push(markdownLine);
    previousCanBeSetext = canPrecedeSetextH1(markdownLine);
    previousContext = context;
  }
  return flushInline();
}

function validateProjectSources(
  input: ProjectCatalogInput["projectSources"],
  projects: IndexedProjects,
  collector: IssueCollector,
): ProjectSource[] {
  const validSources: ProjectSource[] = [];
  const grouped = new Map<string, string[]>();
  const projectIds = new Set(projects.sourceIndexById.keys());
  for (const [inputIndex, source] of input.entries()) {
    if (
      !isRecord(source)
      || typeof source.sourcePath !== "string"
      || typeof source.isSymbolicLink !== "boolean"
      || typeof source.isRealPathWithinRoot !== "boolean"
    ) {
      collector.add(
        "CONTENT_PROJECT_SOURCE_INVALID",
        PROJECTS_PATH,
        `projectSources.${inputIndex}`,
        "项目正文候选必须包含合法路径与真实路径校验结果。",
      );
      continue;
    }
    const classification = classifyContentPath(source);
    if (!classification.ok) {
      collector.merge(classification.issues);
      continue;
    }
    if (classification.value.kind !== "project") {
      collector.add("CONTENT_PROJECT_PATH_LAYOUT", classification.value.sourcePath, undefined, "项目候选不是合法项目正文入口。");
      continue;
    }
    const {projectId, sourcePath} = classification.value;
    const entries = grouped.get(projectId) ?? [];
    entries.push(sourcePath);
    grouped.set(projectId, entries);
    const isKnownProject = projectIds.has(projectId);
    if (!isKnownProject) {
      collector.add("CONTENT_PROJECT_SOURCE_ORPHAN", sourcePath, undefined, "项目正文目录没有对应注册表项目。");
    }
    if (!isRecord(source.frontMatter)) {
      collector.add("CONTENT_PROJECT_FRONTMATTER_INVALID", sourcePath, undefined, "项目正文解码结果必须是 object。");
    } else if (Object.keys(source.frontMatter).length > 0) {
      collector.add("CONTENT_PROJECT_FRONTMATTER_FORBIDDEN", sourcePath, undefined, "项目正文不得包含作者 frontmatter 字段。");
    }
    const hasBody = typeof source.content === "string" && source.content.trim() !== "";
    const hasH1 = hasBody && containsProjectH1(source.content);
    if (!hasBody) {
      collector.add("CONTENT_PROJECT_BODY_INVALID", sourcePath, undefined, "项目正文不得为空。");
    } else if (hasH1) {
      collector.add("CONTENT_PROJECT_H1_FORBIDDEN", sourcePath, undefined, "项目正文不得包含 H1。");
    }
    const hasEmptyFrontMatter = isRecord(source.frontMatter)
      && Object.keys(source.frontMatter).length === 0;
    if (isKnownProject && hasEmptyFrontMatter && hasBody && !hasH1) {
      validSources.push({projectId, sourcePath, content: source.content});
    }
  }
  for (const entries of grouped.values()) {
    if (entries.length > 1) {
      for (const sourcePath of entries) {
        collector.add("CONTENT_PROJECT_SOURCE_DUPLICATE", sourcePath, undefined, "同一项目同时存在多个正文入口。");
      }
    }
  }
  for (const [projectId, publicationStatus] of projects.publicationStatusById) {
    const entries = grouped.get(projectId) ?? [];
    if (["published", "archived"].includes(publicationStatus) && entries.length !== 1) {
      const projectIndex = projects.sourceIndexById.get(projectId);
      collector.add(
        "CONTENT_PROJECT_SOURCE_REQUIRED",
        PROJECTS_PATH,
        projectIndex === undefined ? "projects" : `projects.${projectIndex}.publicationStatus`,
        "公开项目必须恰有一个正文入口。",
      );
    }
  }
  return validSources
    .filter((source) => (grouped.get(source.projectId)?.length ?? 0) === 1)
    .sort((left, right) => compareCodePoints(left.sourcePath, right.sourcePath));
}

function validateCatalogRelations(
  projects: IndexedProjects,
  experiences: IndexedExperiences,
  collector: IssueCollector,
): void {
  const projectIds = new Set(projects.sourceIndexById.keys());
  const experienceCountByProject = new Map<string, number>();
  for (const [experienceId, projectId] of experiences.projectIdById) {
    experienceCountByProject.set(
      projectId,
      (experienceCountByProject.get(projectId) ?? 0) + 1,
    );
    if (!projectIds.has(projectId)) {
      const experienceIndex = experiences.sourceIndexById.get(experienceId);
      collector.add(
        "CONTENT_EXPERIENCE_PROJECT_UNKNOWN",
        EXPERIENCES_PATH,
        experienceIndex === undefined ? "experiences" : `experiences.${experienceIndex}.projectId`,
        "体验引用了未知项目。",
      );
    }
  }
  for (const [projectId, projectIndex] of projects.sourceIndexById) {
    const field = projectIndex === undefined
      ? "projects"
      : `projects.${projectIndex}.experienceRegistryId`;
    const experienceRegistryId = projects.experienceRegistryIdById.get(projectId);
    const matchingCount = experienceCountByProject.get(projectId) ?? 0;
    if (experienceRegistryId !== undefined) {
      const referencedProjectId = experiences.projectIdById.get(experienceRegistryId);
      if (referencedProjectId !== projectId) {
        collector.add("CONTENT_PROJECT_EXPERIENCE_UNKNOWN", PROJECTS_PATH, field, "项目体验外键缺失或反向项目不一致。");
      }
    }
    if (matchingCount > 0 && experienceRegistryId === undefined) {
      collector.add("CONTENT_PROJECT_EXPERIENCE_REQUIRED", PROJECTS_PATH, field, "存在保留体验时项目必须登记 experienceRegistryId。");
    }
    if (matchingCount > 1) {
      collector.add("CONTENT_PROJECT_EXPERIENCE_DUPLICATE", PROJECTS_PATH, field, "同一项目只能绑定一个首版体验记录。");
    }
  }
}

export function validateProjectCatalog(
  input: ProjectCatalogInput,
): ValidationResult<ProjectCatalog> {
  const collector = new IssueCollector();
  if (!isRecord(input)) {
    collector.add("CONTENT_PROJECT_CATALOG_INVALID", PROJECTS_PATH, undefined, "项目目录输入必须是 object。");
    return failure(collector);
  }
  const authors = validateAuthors(input.authors, collector);
  const topics = validateTopics(input.topics, collector);
  const experiences = validateExperiences(input.experiences, collector);
  const projects = validateProjects(input.projects, collector);
  validateCatalogRelations(projects, experiences, collector);
  const projectSources = Array.isArray(input.projectSources)
    ? validateProjectSources(input.projectSources, projects, collector)
    : [];
  if (!Array.isArray(input.projectSources)) {
    collector.add("CONTENT_PROJECT_SOURCE_INVALID", PROJECTS_PATH, "projectSources", "项目正文候选必须是数组。");
  }
  if (collector.hasIssues()) return failure(collector);
  const result = success({
    projects: projects.values,
    authors,
    topics,
    experiences: experiences.values,
    projectSources,
  });
  if (result.ok) VALIDATED_PROJECT_CATALOGS.add(result.value);
  return result;
}

export function isValidatedProjectCatalog(value: unknown): value is ProjectCatalog {
  try {
    return value !== null
      && typeof value === "object"
      && VALIDATED_PROJECT_CATALOGS.has(value);
  } catch {
    return false;
  }
}
