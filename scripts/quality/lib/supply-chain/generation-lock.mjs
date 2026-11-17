import {randomBytes} from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdtempSync,
  openSync, readFileSync, readdirSync, readlinkSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import {hostname} from "node:os";
import {basename, dirname, join} from "node:path";
import {fail} from "./errors.mjs";

function linuxStart(pid) {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  return ["Z", "X"].includes(fields[0]) ? null : fields[19];
}

function machine() {
  return {host: hostname(), platform: process.platform,
    boot: process.platform === "linux" ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() : null,
    namespace: process.platform === "linux" ? readlinkSync("/proc/self/ns/pid") : null};
}

function writeGenerationLockOwner(descriptor, nonce) {
  writeFileSync(descriptor, `${JSON.stringify({schema: 1, ...machine(), pid: process.pid,
    start: process.platform === "linux" ? linuxStart(process.pid) : null,
    nonce})}\n`);
  fsyncSync(descriptor);
}

function owner(path, code) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const held = fstatSync(descriptor), live = lstatSync(path);
    if (!held.isFile() || ![1, 2].includes(held.nlink) || held.size > 4096 || (held.mode & 0o777) !== 0o600
      || (typeof process.getuid === "function" && held.uid !== process.getuid())
      || held.dev !== live.dev || held.ino !== live.ino) throw new Error();
    const value = JSON.parse(readFileSync(descriptor, "utf8"));
    if (value.schema !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1
      || !/^[0-9a-f]{64}$/u.test(value.nonce)
      || Object.keys(value).sort().join() !== "boot,host,namespace,nonce,pid,platform,schema,start") throw new Error();
    const after = fstatSync(descriptor);
    if (after.size !== held.size || after.mtimeMs !== held.mtimeMs || after.ctimeMs !== held.ctimeMs) throw new Error();
    if (held.nlink === 2) {
      const parent = basename(dirname(path)).startsWith(`.${basename(path)}.dead-`)
        ? dirname(dirname(path)) : dirname(path);
      const staging = lstatSync(join(parent, `.${basename(path)}.owner-${value.nonce}`));
      if (!staging.isFile() || staging.dev !== held.dev || staging.ino !== held.ino) throw new Error();
    }
    const here = machine();
    if (value.host !== here.host || value.platform !== here.platform) throw new Error();
    if (here.platform === "linux") {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.boot)
        || !/^pid:\[[0-9]+\]$/u.test(value.namespace)
        || !/^[0-9]+$/u.test(value.start)) throw new Error();
      if (value.boot !== here.boot) return {held, alive: false};
      if (value.namespace !== here.namespace) throw new Error();
      try {
        return {held, alive: linuxStart(value.pid) === value.start};
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return {held, alive: false};
      }
    }
    try {
      process.kill(value.pid, 0);
      return {held, alive: true};
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      return {held, alive: false};
    }
  } catch {
    fail(code, "生成锁身份不明；保留标记并停止，不能凭时间推断持有者已退出。");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function displaceDeadGenerationLock(path, code, syncDirectory) {
  const state = owner(path, code);
  if (state.alive) fail(code, "已有供应链生成任务持有排他锁。");
  // 不覆盖 canonical：竞争者若摘离了新持有者，必须在隔离区看到它仍存活并退出。
  const parent = dirname(path);
  const quarantine = mkdtempSync(join(parent, `.${basename(path)}.dead-`));
  syncDirectory(parent);
  const destination = join(quarantine, basename(path));
  renameSync(path, destination);
  syncDirectory(parent);
  syncDirectory(quarantine);
  const moved = owner(destination, code);
  if (moved.held.dev !== state.held.dev || moved.held.ino !== state.held.ino || moved.alive) {
    fail(code, "锁在恢复摘离期间被替换；隔离标记保留，拒绝进入临界区。");
  }
}

export function assertNoLiveDisplacedLocks(path, code) {
  const parent = dirname(path), prefix = `.${basename(path)}.dead-`;
  for (const name of readdirSync(parent).filter((entry) => entry.startsWith(prefix))) {
    const directory = join(parent, name), metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || (metadata.mode & 0o777) !== 0o700) fail(code, "死亡锁隔离目录身份不明。");
    const entries = readdirSync(directory);
    if (entries.length === 0) continue; // 摘离前崩溃，没有移动任何锁。
    if (entries.length !== 1 || entries[0] !== basename(path) || owner(join(directory, entries[0]), code).alive) {
      fail(code, "隔离标记仍有存活持有者或未知成员；拒绝并发恢复。");
    }
  }
}

export function createGenerationLock(path, code, syncDirectory) {
  const nonce = randomBytes(32).toString("hex");
  const temporary = join(dirname(path), `.${basename(path)}.owner-${nonce}`);
  const descriptor = openSync(temporary, "wx", 0o600);
  let returned = false;
  try {
    // 先完整写入再原子争用 canonical，死亡不能留下无法识别 owner 的半写锁。
    writeGenerationLockOwner(descriptor, nonce);
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      displaceDeadGenerationLock(path, code, syncDirectory);
      linkSync(temporary, path);
    }
    const held = fstatSync(descriptor), staged = lstatSync(temporary);
    if (held.dev !== staged.dev || held.ino !== staged.ino) fail(code, "生成锁准备文件已被替换。");
    unlinkSync(temporary);
    returned = true;
    return descriptor;
  } finally {
    if (!returned) closeSync(descriptor);
  }
}
