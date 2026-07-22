import type {ContentIssue, ValidationResult} from "./types.js";

const GRAPHEME_SEGMENTER = new Intl.Segmenter("zh-CN", {
  granularity: "grapheme",
});
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const FIELD_PATH_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u;
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

export function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index] - rightPoints[index];
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function isSafeDiagnosticPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/")) {
    return false;
  }
  if (value.includes("\\") || CONTROL_PATTERN.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export class IssueCollector {
  readonly #issues = new Map<string, ContentIssue>();

  add(
    code: string,
    sourcePath: string,
    fieldPath: string | undefined,
    message: string,
  ): void {
    const safeSourcePath = isSafeDiagnosticPath(sourcePath)
      ? sourcePath
      : "site-content";
    const normalizedFieldPath = fieldPath === "" || fieldPath === undefined
      ? undefined
      : fieldPath.length <= 512 && FIELD_PATH_PATTERN.test(fieldPath)
        ? fieldPath
        : "unknownField";
    const identity = `${safeSourcePath}\u0000${normalizedFieldPath ?? ""}\u0000${code}`;
    if (!this.#issues.has(identity)) {
      const issue: ContentIssue = normalizedFieldPath === undefined
        ? Object.freeze({code, sourcePath: safeSourcePath, message})
        : Object.freeze({code, sourcePath: safeSourcePath, fieldPath: normalizedFieldPath, message});
      this.#issues.set(identity, issue);
    }
  }

  merge(issues: readonly ContentIssue[]): void {
    for (const issue of issues) {
      this.add(issue.code, issue.sourcePath, issue.fieldPath, issue.message);
    }
  }

  hasIssues(): boolean {
    return this.#issues.size > 0;
  }

  sorted(): readonly ContentIssue[] {
    return Object.freeze([...this.#issues.values()].sort((left, right) => (
      compareCodePoints(left.sourcePath, right.sourcePath)
      || compareCodePoints(left.fieldPath ?? "", right.fieldPath ?? "")
      || compareCodePoints(left.code, right.code)
    )));
  }
}

export function success<T>(value: T): ValidationResult<T> {
  return Object.freeze({ok: true, value: deepFreeze(value)});
}

export function failure<T>(collector: IssueCollector): ValidationResult<T> {
  return Object.freeze({ok: false, issues: collector.sorted()});
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function graphemeLength(value: string): number {
  return [...GRAPHEME_SEGMENTER.segment(value)].length;
}

export function isSingleLineText(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return typeof value === "string"
    && value === value.trim()
    && value.length > 0
    && !CONTROL_PATTERN.test(value)
    && !value.includes("\n")
    && !value.includes("\r")
    && graphemeLength(value) >= minimum
    && graphemeLength(value) <= maximum;
}

export function isKebabId(value: unknown, maximum = 64): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maximum
    && ID_PATTERN.test(value);
}

export function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7_PATTERN.test(value);
}

export function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= minimum
    && (value as number) <= maximum;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const isLeap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return isLeap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return year >= 1
    && month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth(year, month);
}

export function isYearMonthOrDate(value: unknown): value is string {
  if (isDate(value)) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/u.test(value)) return false;
  const [year, month] = value.split("-").map(Number);
  return year >= 1 && month >= 1 && month <= 12;
}

export function isHttpsUrl(value: unknown, allowQueryAndFragment = true): value is string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !value.startsWith("https://")
    || value.includes("\\")
    || CONTROL_PATTERN.test(value)
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && url.hostname !== ""
      && url.href === value
      && (allowQueryAndFragment || (url.search === "" && url.hash === ""));
  } catch {
    return false;
  }
}

export function isRepositoryRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.startsWith("/")
    || URL_SCHEME_PATTERN.test(value)
  ) return false;
  if (value.includes("\\") || CONTROL_PATTERN.test(value)) return false;
  return value.split("/").every((segment) => (
    segment !== ""
    && segment !== "."
    && segment !== ".."
    && segment === segment.trim()
  ));
}

export function isRootRelativePath(value: unknown, extension?: string): value is string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !value.startsWith("/")
    || value === "/"
  ) return false;
  if (
    value.includes("\\")
    || value.includes("//")
    || value.includes("%")
    || /\s/u.test(value)
    || CONTROL_PATTERN.test(value)
  ) return false;
  if (/[?#]/u.test(value)) return false;
  const segments = value.slice(1).split("/");
  if (segments.some((segment) => (
    segment === ""
    || segment === "."
    || segment === ".."
    || segment !== segment.trim()
  ))) return false;
  return extension === undefined || value.endsWith(extension);
}

export function isSafeGitRef(value: unknown): value is string {
  if (!isSingleLineText(value, 1, 100)) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)) return false;
  const components = value.split("/");
  return components.every((component) => (
    component !== ""
    && !component.startsWith(".")
    && !component.endsWith(".lock")
  ))
    && !value.includes("..")
    && !value.includes("//")
    && !value.includes("@{")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && value !== "@"
    && value !== "HEAD";
}

export function exactObjectKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  collector: IssueCollector,
  sourcePath: string,
  fieldPrefix: string,
  subject: string,
): void {
  const allowedSet = new Set(allowed);
  const valueKeys = Object.keys(value).sort(compareCodePoints);
  for (const key of valueKeys) {
    if (!allowedSet.has(key)) {
      const diagnosticKey = /^[A-Za-z0-9_-]{1,100}$/u.test(key)
        ? key
        : "unknownField";
      collector.add(
        `CONTENT_${subject}_FIELD_UNKNOWN`,
        sourcePath,
        joinField(fieldPrefix, diagnosticKey),
        "字段不属于当前内容 schema。",
      );
    }
  }
  for (const key of [...required].sort(compareCodePoints)) {
    if (!Object.hasOwn(value, key)) {
      collector.add(
        `CONTENT_${subject}_FIELD_REQUIRED`,
        sourcePath,
        joinField(fieldPrefix, key),
        "缺少必填字段。",
      );
    }
  }
}

export function joinField(prefix: string, field: string | number): string {
  return prefix === "" ? String(field) : `${prefix}.${String(field)}`;
}

export function arraysEqual(actual: unknown, expected: readonly unknown[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

export function hasDuplicateStrings(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

export function isUniqueStringArray(
  value: unknown,
  minimum: number,
  maximum: number,
  predicate: (entry: unknown) => entry is string,
): value is string[] {
  return Array.isArray(value)
    && value.length >= minimum
    && value.length <= maximum
    && value.every((entry) => predicate(entry))
    && !hasDuplicateStrings(value);
}
