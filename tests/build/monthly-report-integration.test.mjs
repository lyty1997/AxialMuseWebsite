import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {test} from "node:test";
import {main} from "../../scripts/maintenance/monthly-report.mjs";

test("CLI 真实冻结解码器与私有到期 fixture 生成新回执且拒绝覆盖", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "axial-monthly-integration-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const now = new Date();
  const future = new Date(now.valueOf() + 100 * 86400000).toISOString().slice(0, 10);
  const expiryPath = resolve(root, "fixture-only-expiry.json");
  const outputPath = resolve(root, "fixture-only-report.json");
  writeFileSync(expiryPath, JSON.stringify({schema: 1, verifiedAtUtc: now.toISOString(),
    domainExpiresOn: future, instanceExpiresOn: future}), {mode: 0o600});
  const args = ["--expiry", expiryPath, "--output", outputPath];
  assert.equal(await main(args), 0);
  const bytes = readFileSync(outputPath);
  const report = JSON.parse(bytes);
  assert.equal(report.status, "passed");
  assert.equal(report.scope, "local-checkout");
  assert.ok(report.content.every((record) => record.updatedAt && record.id));
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
  assert.ok(!bytes.includes(Buffer.from("verifiedAtUtc")));
  assert.equal(await main(args), 1);
  assert.deepEqual(readFileSync(outputPath), bytes);
});
