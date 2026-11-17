import {createHash, randomBytes} from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdtempSync, openSync,
  readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import {basename, dirname, join, resolve} from "node:path";
import {fail} from "./errors.mjs";

const CODE = "SPDX_ARTIFACT_PUBLISH_UNCERTAIN";
const FILES = ["dependency-evidence.json", "sbom.spdx.json"];
const requireValue = (value) => { if (!value) fail(CODE, "供应链持久事务或文件身份不一致；保留现场。"); };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identity = (value) => ({dev: value.dev, ino: value.ino, mode: value.mode, uid: value.uid, nlink: value.nlink});
const same = (left, right) => ["dev", "ino", "mode", "uid", ...((right.mode & 0o170000) === 0o040000 ? [] : ["nlink"])]
  .every((key) => left[key] === right[key]);

export function syncPublicationDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function exists(path) {
  try { lstatSync(path); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function file(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = fstatSync(fd);
    requireValue(metadata.isFile() && metadata.nlink === 1 && metadata.size <= 64 * 1024 * 1024);
    const bytes = readFileSync(fd);
    requireValue(bytes.length === metadata.size && same(identity(metadata), identity(lstatSync(path)))
      && fstatSync(fd).mtimeMs === metadata.mtimeMs && fstatSync(fd).ctimeMs === metadata.ctimeMs);
    return {identity: identity(metadata), sha256: digest(bytes), size: bytes.length};
  } finally { closeSync(fd); }
}

function directory(path) {
  const metadata = lstatSync(path);
  requireValue(metadata.isDirectory() && !metadata.isSymbolicLink());
  return identity(metadata);
}

function describe(path, kind, expectedIdentity, snapshot) {
  if (expectedIdentity === null) { requireValue(!exists(path)); return null; }
  const metadata = kind === "artifact" ? directory(path) : file(path).identity;
  // 与发布者从创建/首次读取起持有的身份绑定，不能重新收养同字节外部 inode。
  requireValue(metadata.dev === expectedIdentity.dev && metadata.ino === expectedIdentity.ino
    && metadata.uid === expectedIdentity.uid && metadata.nlink === expectedIdentity.nlink);
  const names = kind === "artifact" ? FILES : [""];
  const files = Object.fromEntries(names.map((name) => {
    const value = file(name ? join(path, name) : path);
    const expected = name ? expectedIdentity.artifactFileIdentities[name] : expectedIdentity;
    const bytes = name === "dependency-evidence.json" ? snapshot.evidenceBytes
      : name === "sbom.spdx.json" ? snapshot.sbomBytes : snapshot;
    requireValue(value.identity.dev === expected.dev && value.identity.ino === expected.ino
      && value.sha256 === digest(bytes));
    return [name, value];
  }));
  return {kind, identity: metadata, files};
}

function checkObject(path, expected, partial = false) {
  requireValue(expected !== null);
  const actual = expected.kind === "artifact" ? directory(path) : file(path).identity;
  requireValue(same(actual, expected.identity));
  const names = expected.kind === "artifact" ? readdirSync(path) : [""];
  requireValue((partial || names.length === Object.keys(expected.files).length)
    && names.every((name) => Object.hasOwn(expected.files, name)));
  for (const name of names) {
    const current = file(name ? join(path, name) : path), wanted = expected.files[name];
    requireValue(same(current.identity, wanted.identity) && current.sha256 === wanted.sha256 && current.size === wanted.size);
  }
}

export function publicationJournalPath(artifactDirectory) {
  return join(dirname(resolve(artifactDirectory)), `.${basename(artifactDirectory)}.transaction.json`);
}

function save(transaction, phase) {
  const value = {...transaction.value, phase};
  const path = transaction.path;
  if (transaction.raw !== undefined) requireValue(readFileSync(path, "utf8") === transaction.raw
    && same(file(path).identity, transaction.journalIdentity));
  else requireValue(!exists(path));
  const temporary = `${path}.prepared-${randomBytes(16).toString("hex")}`;
  const fd = openSync(temporary, "wx", 0o600);
  const raw = `${JSON.stringify(value)}\n`;
  try { writeFileSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  transaction.value = value;
  transaction.raw = raw;
  transaction.journalIdentity = file(path).identity;
  transaction.step(`journal-${phase}-renamed`);
  syncPublicationDirectory(dirname(path));
  transaction.step(`journal-${phase}`);
}

export function beginPublication({artifactDirectory, noticePath, artifactCandidate,
  noticeCandidateDirectory, previousArtifact, previousNotice, nextArtifact, nextNotice,
  previousArtifactIdentity, previousNoticeIdentity, nextArtifactIdentity, nextNoticeIdentity,
  step = () => {}}) {
  const targets = [resolve(artifactDirectory), resolve(noticePath)];
  const candidates = [artifactCandidate, join(noticeCandidateDirectory, basename(noticePath))];
  const containers = [noticeCandidateDirectory];
  const objects = targets.map((target, index) => {
    const rollback = mkdtempSync(join(dirname(target), `.${basename(target)}.rollback-`));
    containers.push(rollback);
    const kind = index === 0 ? "artifact" : "notice";
    return {target, backup: join(dirname(target), `.${basename(target)}.backup`),
      candidate: candidates[index], rollback: join(rollback, basename(target)),
      previous: describe(target, kind, index === 0 ? previousArtifactIdentity : previousNoticeIdentity,
        index === 0 ? previousArtifact : previousNotice),
      next: describe(candidates[index], kind, index === 0 ? nextArtifactIdentity : nextNoticeIdentity,
        index === 0 ? nextArtifact : nextNotice)};
  });
  const value = {schema: 1, phase: "prepared", objects,
    parents: [...new Set(targets.map(dirname))].map((path) => ({path, identity: directory(path)})),
    containers: containers.map((path) => ({path, identity: directory(path)}))};
  for (const parent of value.parents) syncPublicationDirectory(parent.path);
  const transaction = {path: publicationJournalPath(artifactDirectory), value, step};
  return transaction;
}

export function preparePublication(transaction) {
  save(transaction, "prepared");
}

function validate(transaction, artifactDirectory, noticePath) {
  const {value} = transaction;
  requireValue(value.schema === 1 && ["prepared", "committed", "rolled-back"].includes(value.phase)
    && Object.keys(value).sort().join() === "containers,objects,parents,phase,schema"
    && Array.isArray(value.objects) && value.objects.length === 2
    && Array.isArray(value.parents) && Array.isArray(value.containers) && value.containers.length === 3);
  const targets = [resolve(artifactDirectory), resolve(noticePath)];
  requireValue(value.objects.every((entry, index) => entry.target === targets[index]
    && Object.keys(entry).sort().join() === "backup,candidate,next,previous,rollback,target"
    && entry.backup === join(dirname(entry.target), `.${basename(entry.target)}.backup`)));
  const [artifact, notice] = value.objects;
  const privatePath = (path, target, label) => typeof path === "string" && dirname(path) === dirname(target)
    && basename(path).startsWith(`.${basename(target)}.${label}-`) && /^[A-Za-z0-9_-]+$/u.test(basename(path).split(`${label}-`)[1]);
  requireValue(privatePath(artifact.candidate, artifact.target, "candidate")
    && privatePath(dirname(notice.candidate), notice.target, "candidate")
    && basename(notice.candidate) === basename(notice.target));
  for (const entry of value.objects) {
    requireValue(privatePath(dirname(entry.rollback), entry.target, "rollback")
      && basename(entry.rollback) === basename(entry.target));
    for (const record of [entry.previous, entry.next].filter((item) => item !== null)) {
      requireValue(record.kind === (entry === artifact ? "artifact" : "notice")
        && Object.keys(record.files).sort().join() === (entry === artifact ? [...FILES].sort().join() : ""));
    }
  }
  const expectedContainers = [dirname(notice.candidate), dirname(artifact.rollback), dirname(notice.rollback)];
  requireValue(value.containers.every((entry, index) => entry.path === expectedContainers[index]));
  const parents = [...new Set(targets.map(dirname))];
  requireValue(value.parents.length === parents.length);
  for (const [index, entry] of value.parents.entries()) {
    requireValue(entry.path === parents[index] && same(directory(entry.path), entry.identity));
  }
  for (const entry of value.containers) {
    if (!exists(entry.path)) {
      requireValue(value.phase !== "prepared");
      continue;
    }
    requireValue(same(directory(entry.path), entry.identity));
    const allowed = entry.path === dirname(notice.candidate) ? basename(notice.candidate)
      : entry.path === dirname(artifact.rollback) ? basename(artifact.rollback) : basename(notice.rollback);
    requireValue(readdirSync(entry.path).every((name) => name === allowed));
  }
}

function move(transaction, from, to, name, sync) {
  requireValue(!exists(to));
  renameSync(from, to);
  transaction.step(`${name}-renamed`);
  for (const parent of new Set([dirname(from), dirname(to)])) sync(parent);
  transaction.step(name);
}

function removeObject(transaction, path, expected, sync) {
  if (!exists(path)) return;
  checkObject(path, expected, true);
  sync(dirname(path));
  if (expected.kind === "artifact") {
    for (const name of readdirSync(path).sort()) {
      checkObject(path, expected, true);
      unlinkSync(join(path, name));
      transaction.step(`cleanup-${basename(path)}-${name}-unlinked`);
      sync(path);
    }
    rmdirSync(path);
  } else {
    unlinkSync(path);
  }
  transaction.step(`cleanup-${basename(path)}-removed`);
  sync(dirname(path));
}

export function settlePublication(transaction, {commit = false, sync = syncPublicationDirectory,
  afterOwnershipCheck = null} = {}) {
  const {objects} = transaction.value;
  requireValue(readFileSync(transaction.path, "utf8") === transaction.raw
    && same(file(transaction.path).identity, transaction.journalIdentity));
  validate(transaction, objects[0].target, objects[1].target);
  if (commit) {
    for (const entry of objects) checkObject(entry.target, entry.next);
    save(transaction, "committed");
  }
  const phase = transaction.value.phase;
  if (phase === "prepared") {
    // 在移动任何一个对象前验证整个三件套，不能先恢复一半再发现另一个被篡改。
    const locations = objects.map((entry) => {
      const old = [entry.target, entry.backup].filter((path) => exists(path)
        && entry.previous !== null && same(identity(lstatSync(path)), entry.previous.identity));
      const fresh = [entry.target, entry.candidate, entry.rollback].filter((path) => exists(path)
        && same(identity(lstatSync(path)), entry.next.identity));
      requireValue(old.length === (entry.previous === null ? 0 : 1) && fresh.length === 1);
      for (const path of [entry.target, entry.backup, entry.candidate, entry.rollback].filter(exists)) {
        requireValue(old.includes(path) || fresh.includes(path));
      }
      if (old.length) checkObject(old[0], entry.previous);
      checkObject(fresh[0], entry.next);
      return {old: old[0], fresh: fresh[0]};
    });
    for (const [index, entry] of objects.entries()) {
      if (locations[index].fresh === entry.target) {
        checkObject(entry.target, entry.next);
        if (afterOwnershipCheck) afterOwnershipCheck(entry.next.kind);
        move(transaction, entry.target, entry.rollback, `rollback-${index}`, sync);
        checkObject(entry.rollback, entry.next);
      }
    }
    for (const [index, entry] of objects.entries()) {
      if (locations[index].old === entry.backup) {
        move(transaction, entry.backup, entry.target, `restore-${index}`, sync);
      }
      if (entry.previous === null) requireValue(!exists(entry.target));
      else checkObject(entry.target, entry.previous);
    }
    save(transaction, "rolled-back");
  }
  const committed = transaction.value.phase === "committed";
  for (const entry of objects) {
    const wanted = committed ? entry.next : entry.previous;
    if (wanted === null) requireValue(!exists(entry.target));
    else checkObject(entry.target, wanted);
    const disposable = committed ? entry.previous : entry.next;
    for (const path of committed ? [entry.backup, entry.rollback] : [entry.candidate, entry.rollback]) {
      if (exists(path)) checkObject(path, disposable, true);
    }
    requireValue(!exists(committed ? entry.candidate : entry.backup));
  }
  for (const entry of objects) {
    if (committed && exists(entry.backup)) {
      // 先同步再摘离；失败保留旧备份，已提交 canonical 始终保留新代。
      sync(dirname(entry.backup));
      move(transaction, entry.backup, entry.rollback, `retire-${entry.next.kind}`, sync);
      checkObject(entry.rollback, entry.previous, true);
    }
    for (const path of committed ? [entry.rollback] : [entry.candidate, entry.rollback]) {
      removeObject(transaction, path, committed ? entry.previous : entry.next, sync);
    }
  }
  for (const [index, entry] of transaction.value.containers.entries()) {
    if (!exists(entry.path)) continue;
    requireValue(same(directory(entry.path), entry.identity) && readdirSync(entry.path).length === 0);
    rmdirSync(entry.path);
    transaction.step(`container-${index}-removed`);
    sync(dirname(entry.path));
  }
  requireValue(readFileSync(transaction.path, "utf8") === transaction.raw
    && same(file(transaction.path).identity, transaction.journalIdentity));
  unlinkSync(transaction.path);
  sync(dirname(transaction.path));
  transaction.step("journal-removed");
}

export function recoverPublication({artifactDirectory, noticePath, step = () => {}}) {
  const path = publicationJournalPath(artifactDirectory);
  if (!exists(path)) return false;
  try {
    const metadata = file(path);
    requireValue(metadata.size <= 65536 && (metadata.identity.mode & 0o777) === 0o600
      && (typeof process.getuid !== "function" || metadata.identity.uid === process.getuid()));
    const raw = readFileSync(path, "utf8"), value = JSON.parse(raw);
    requireValue(raw === `${JSON.stringify(value)}\n`);
    const transaction = {path, raw, value, step, journalIdentity: metadata.identity};
    validate(transaction, artifactDirectory, noticePath);
    settlePublication(transaction);
    return true;
  } catch {
    fail(CODE, "供应链中断事务无法安全恢复；保留 canonical、备份与事务记录。");
  }
}
