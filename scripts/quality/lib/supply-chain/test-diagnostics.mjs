import {spawnSync} from "node:child_process";

const CODES = Object.freeze([
  "TEST_COMPILE", "TEST_EXECUTION", "TEST_EMIT", "TEST_CLEANUP", "TEST_INTERNAL",
  "ERR_ASSERTION", "BROWSER_PROTOCOL", "BROWSER_TIMEOUT", "BROWSER_HYDRATION",
  "BROWSER_NETWORK_IDLE", "BROWSER_UNAVAILABLE", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
]);

export function summarizeTestFailure(result, root) {
  // 失败输出也可能含私密值；只提取封闭代码、计数和 Git 已登记的源码位置。
  const text = [result?.stdout, result?.stderr]
    .filter((value) => typeof value === "string")
    .map((value) => value.slice(-128 * 1024)).join("\n")
    .replace(/\u001b\[[0-9;]*m/gu, "");
  const codes = CODES.filter((code) => new RegExp(`\\b${code}\\b`, "u").test(text));
  const counts = [...text.matchAll(/^(?:ℹ|#) fail ([0-9]{1,5})\r?$/gmu)];
  const failedCount = counts.length === 0 ? null : Number(counts.at(-1)[1]);
  let tracked = new Set();
  try {
    const git = spawnSync("git", ["-C", root, "ls-files", "-z", "--", "tests", "src", "scripts"], {
      encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
    });
    if (git.status === 0) tracked = new Set(git.stdout.split("\0"));
  } catch {
    // 无可信源码清单时仍保持失败，只省略位置，绝不返回原始输出。
  }
  const locations = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(?:test at |at (?:[^()\n]{1,160}\()?)(?:<test-output>\/)?((?:tests|src|scripts)\/[A-Za-z0-9_./-]+):([0-9]{1,6}):([0-9]{1,5})\)?\s*$/u);
    if (match === null || match[1].split("/").includes("..")) continue;
    const input = match[1];
    const source = tracked.has(input) ? input : input.endsWith(".js")
      ? [input.slice(0, -3) + ".ts", input.slice(0, -3) + ".tsx"].find((path) => tracked.has(path))
      : undefined;
    if (source === undefined || !tracked.has(source) || !/\.(?:mjs|[cm]?ts|tsx|js)$/u.test(source)) continue;
    const location = {source, emittedLine: Number(match[2]), emittedColumn: Number(match[3])};
    if (!locations.some((item) => JSON.stringify(item) === JSON.stringify(location))) locations.push(location);
    if (locations.length === 8) break;
  }
  return Object.freeze({codes, failedCount, locations});
}
