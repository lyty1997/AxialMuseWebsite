import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, readdirSync, realpathSync, writeFileSync,
} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {decodeFrontMatter} from "../content/frontmatter.mjs";
import {decodeJsonDocument} from "../content/json.mjs";
import {projectRoot} from "../quality/lib/files.mjs";

const DAY = 86400000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const PUBLIC = new Set(["published", "archived"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export class MonthlyError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function requireValue(condition, code) {
  if (!condition) throw new MonthlyError(code);
}

function dateValue(value) {
  requireValue(typeof value === "string" && DATE.test(value), "MONTHLY_DATE");
  const time = Date.parse(`${value}T00:00:00Z`);
  requireValue(Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value, "MONTHLY_DATE");
  return time;
}

function identity(metadata) {
  return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs, metadata.mode, metadata.uid,
    metadata.nlink].map(String).join(":");
}

function readSnapshot(path, sourcePath, privateInput = false) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor, {bigint: true});
    requireValue(before.isFile() && before.size <= BigInt(MAX_FILE_BYTES) && before.nlink === 1n
      && before.uid === BigInt(process.getuid())
      && (!privateInput || (before.mode & 0o777n) === 0o600n), "MONTHLY_INPUT");
    const bytes = readFileSync(descriptor);
    requireValue(identity(before) === identity(fstatSync(descriptor, {bigint: true}))
      && identity(before) === identity(lstatSync(path, {bigint: true})), "MONTHLY_INPUT_DRIFT");
    return {path, sourcePath, bytes, identity: identity(before)};
  } finally {
    closeSync(descriptor);
  }
}

function directorySnapshot(path) {
  const metadata = lstatSync(path, {bigint: true});
  requireValue(metadata.isDirectory() && !metadata.isSymbolicLink()
    && metadata.uid === BigInt(process.getuid()), "MONTHLY_DIRECTORY");
  return {path, identity: identity(metadata), names: readdirSync(path).sort()};
}

export async function collectContentDates({root = projectRoot(), decode = decodeFrontMatter} = {}) {
  requireValue(resolve(root) === realpathSync(root), "MONTHLY_DIRECTORY");
  const snapshots = [];
  let totalBytes = 0;
  const directories = [directorySnapshot(root), directorySnapshot(resolve(root, "docs")),
    directorySnapshot(resolve(root, "docs/contracts")), directorySnapshot(resolve(root, "site-content")),
    directorySnapshot(resolve(root, "site-content/writing"))];
  const read = (sourcePath) => {
    const captured = readSnapshot(resolve(root, sourcePath), sourcePath);
    totalBytes += captured.bytes.length;
    requireValue(totalBytes <= 32 * 1024 * 1024, "MONTHLY_CONTENT_LIMIT");
    snapshots.push(captured);
    return captured;
  };
  const projectsFile = read("docs/contracts/projects.json");
  const projects = decodeJsonDocument(projectsFile).projects;
  requireValue(Array.isArray(projects), "MONTHLY_PROJECTS");
  const records = [];
  for (const project of projects) {
    if (PUBLIC.has(project.publicationStatus)) {
      requireValue(typeof project.id === "string" && ID.test(project.id), "MONTHLY_CONTENT");
      dateValue(project.updatedAt);
      records.push({kind: "project", id: project.id, sourcePath: projectsFile.sourcePath, updatedAt: project.updatedAt});
    }
  }
  const writing = directories.at(-1);
  requireValue(writing.names.length <= 10000, "MONTHLY_CONTENT_LIMIT");
  for (const name of writing.names) {
    if (name === ".gitkeep") {
      read("site-content/writing/.gitkeep");
      continue;
    }
    requireValue(ID.test(name), "MONTHLY_SOURCE_NAME");
    const directory = directorySnapshot(resolve(writing.path, name));
    directories.push(directory);
    const entries = directory.names.filter((entry) => entry === "index.md" || entry === "index.mdx");
    requireValue(entries.length === 1, "MONTHLY_ARTICLE_SOURCE");
    const source = read(`site-content/writing/${name}/${entries[0]}`);
    const parsed = await decode({fileContent: new TextDecoder("utf-8", {fatal: true}).decode(source.bytes),
      filePath: source.path, sourcePath: source.sourcePath});
    if (PUBLIC.has(parsed.frontMatter.publicationStatus)) {
      const {articleId, updatedAt} = parsed.frontMatter;
      requireValue(typeof articleId === "string" && /^[0-9a-f-]{36}$/u.test(articleId), "MONTHLY_CONTENT");
      dateValue(updatedAt);
      records.push({kind: "article", id: articleId, sourcePath: source.sourcePath, updatedAt});
    }
  }
  for (const snapshot of [...snapshots, ...directories]) {
    requireValue(identity(lstatSync(snapshot.path, {bigint: true})) === snapshot.identity, "MONTHLY_INPUT_DRIFT");
    if (snapshot.names) {
      requireValue(JSON.stringify(readdirSync(snapshot.path).sort()) === JSON.stringify(snapshot.names),
        "MONTHLY_INPUT_DRIFT");
    }
  }
  requireValue(new Set(records.map((record) => `${record.kind}:${record.id}`)).size === records.length,
    "MONTHLY_CONTENT_DUPLICATE");
  return records;
}

export function monthlyReport({content, expiry, now = new Date()}) {
  requireValue(now instanceof Date && Number.isFinite(now.valueOf()) && Array.isArray(content), "MONTHLY_INPUT");
  const today = dateValue(now.toISOString().slice(0, 10));
  const checks = [];
  const dates = content.map((record) => {
    const ageDays = Math.floor((today - dateValue(record.updatedAt)) / DAY);
    checks.push({check: `content:${record.kind}:${record.id}`, status: ageDays >= 0 ? "passed" : "failed",
      ...(ageDays < 0 ? {code: "MONTHLY_CONTENT_FUTURE"} : {})});
    return {...record, ageDays};
  });
  const expiryKeys = ["domainExpiresOn", "instanceExpiresOn", "schema", "verifiedAtUtc"];
  requireValue(expiry && typeof expiry === "object" && !Array.isArray(expiry)
    && JSON.stringify(Object.keys(expiry).sort()) === JSON.stringify(expiryKeys) && expiry.schema === 1
    && typeof expiry.verifiedAtUtc === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(expiry.verifiedAtUtc), "MONTHLY_EXPIRY_INPUT");
  const verified = Date.parse(expiry.verifiedAtUtc);
  requireValue(Number.isFinite(verified)
    && new Date(verified).toISOString().replace(".000Z", "Z") === expiry.verifiedAtUtc.replace(".000Z", "Z"),
    "MONTHLY_EXPIRY_INPUT");
  const age = now.valueOf() - verified;
  checks.push({check: "expiry:verification", status: age >= 0 && age <= 35 * DAY ? "passed" : "failed",
    ...(age < 0 || age > 35 * DAY ? {code: "MONTHLY_EXPIRY_VERIFICATION"} : {})});
  for (const resource of ["domain", "instance"]) {
    const daysRemaining = Math.floor((dateValue(expiry[`${resource}ExpiresOn`]) - today) / DAY);
    checks.push({check: `expiry:${resource}`, daysRemaining, status: daysRemaining > 45 ? "passed" : "failed",
      ...(daysRemaining <= 45 ? {code: daysRemaining < 0 ? "MONTHLY_EXPIRED" : "MONTHLY_EXPIRY_APPROACHING"} : {})});
  }
  const failedCount = checks.filter((check) => check.status === "failed").length;
  return {schema: 1, scope: "local-checkout", observedAtUtc: now.toISOString(),
    status: failedCount ? "failed" : "passed", checks, content: dates, failedCount,
    checkCount: checks.length, mutationsPerformed: false};
}

export async function main(arguments_ = process.argv.slice(2)) {
  try {
    requireValue(arguments_.length === 4 && arguments_[0] === "--expiry" && arguments_[2] === "--output",
      "MONTHLY_ARGUMENTS");
    const expirySnapshot = readSnapshot(resolve(arguments_[1]), "maintenance/private-expiry.json", true);
    const expiry = decodeJsonDocument(expirySnapshot);
    const content = await collectContentDates();
    requireValue(identity(lstatSync(expirySnapshot.path, {bigint: true})) === expirySnapshot.identity, "MONTHLY_INPUT_DRIFT");
    const report = monthlyReport({content, expiry});
    const descriptor = openSync(resolve(arguments_[3]), constants.O_WRONLY | constants.O_CREAT
      | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(report)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    console.log(JSON.stringify({status: report.status, checkCount: report.checkCount, failedCount: report.failedCount}));
    return report.status === "passed" ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({status: "failed", code: error instanceof MonthlyError ? error.code : "MONTHLY_EXECUTION"}));
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
