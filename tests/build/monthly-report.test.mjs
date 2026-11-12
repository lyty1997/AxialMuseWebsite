import assert from "node:assert/strict";
import {chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {test} from "node:test";
import {collectContentDates, main, monthlyReport} from "../../scripts/maintenance/monthly-report.mjs";

const NOW = new Date("2026-11-11T10:00:00Z");
const EXPIRY = Object.freeze({schema: 1, verifiedAtUtc: "2026-11-10T00:00:00Z",
  domainExpiresOn: "2027-04-01", instanceExpiresOn: "2027-04-01"});
const CONTENT = Object.freeze([{kind: "project", id: "fixture", sourcePath: "docs/contracts/projects.json",
  updatedAt: "2026-01-01"}]);

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), "axial-monthly-test-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(resolve(root, "docs/contracts"), {recursive: true});
  mkdirSync(resolve(root, "site-content/writing/published"), {recursive: true});
  mkdirSync(resolve(root, "site-content/writing/draft"));
  const projectsPath = resolve(root, "docs/contracts/projects.json");
  writeFileSync(projectsPath, JSON.stringify({projects: [
    {id: "visible", publicationStatus: "published", updatedAt: "2026-01-01"},
    {id: "private-draft", publicationStatus: "draft", updatedAt: "2026-01-01"},
  ]}));
  const published = {articleId: "019fb119-5f31-7f80-bb8b-79c2b70f1f60", publicationStatus: "published",
    updatedAt: "2026-11-04"};
  writeFileSync(resolve(root, "site-content/writing/published/index.md"), JSON.stringify(published));
  writeFileSync(resolve(root, "site-content/writing/draft/index.mdx"), JSON.stringify({
    articleId: "private-article", publicationStatus: "draft", updatedAt: "2026-11-04",
  }));
  const decode = async ({fileContent}) => ({frontMatter: JSON.parse(fileContent), content: ""});
  return {root, projectsPath, published, decode};
}

test("月度报告列出更新时间与年龄，不以内容年龄虚构故障", () => {
  const result = monthlyReport({content: CONTENT, expiry: EXPIRY, now: NOW});
  assert.equal(result.status, "passed");
  assert.equal(result.content[0].ageDays, 314);
  assert.equal(result.scope, "local-checkout");
  assert.equal(result.mutationsPerformed, false);
  assert.equal(result.failedCount, 0);
});

test("45 天和已过期分别发出可识别失败，46 天通过", () => {
  for (const [date, code] of [["2026-12-26", "MONTHLY_EXPIRY_APPROACHING"], ["2026-11-10", "MONTHLY_EXPIRED"],
    ["2026-12-27", undefined]]) {
    const result = monthlyReport({content: CONTENT, expiry: {...EXPIRY, domainExpiresOn: date}, now: NOW});
    const check = result.checks.find((entry) => entry.check === "expiry:domain");
    assert.equal(check.code, code);
    assert.equal(check.status, code ? "failed" : "passed");
  }
});

test("过旧或未来的到期核验记录不当作已确认事实", () => {
  for (const verifiedAtUtc of ["2026-10-01T00:00:00Z", "2026-11-12T00:00:00Z"]) {
    const result = monthlyReport({content: CONTENT, expiry: {...EXPIRY, verifiedAtUtc}, now: NOW});
    assert.equal(result.status, "failed");
    assert.equal(result.checks.find((entry) => entry.check === "expiry:verification").code,
      "MONTHLY_EXPIRY_VERIFICATION");
  }
});

test("缺失记录、额外字段、无时区或规范化后变日的日期拒绝", () => {
  for (const expiry of [null, {}, {...EXPIRY, account: "private"}, {...EXPIRY, verifiedAtUtc: "2026-11-10T00:00:00"},
    {...EXPIRY, verifiedAtUtc: "2026-02-30T00:00:00Z"}, {...EXPIRY, instanceExpiresOn: "2027-02-30"}]) {
    assert.throws(() => monthlyReport({content: CONTENT, expiry, now: NOW}), /MONTHLY_(EXPIRY_INPUT|DATE)/u);
  }
});

test("未来内容更新时间失败，非法日期直接拒绝", () => {
  const result = monthlyReport({content: [{...CONTENT[0], updatedAt: "2026-11-12"}], expiry: EXPIRY, now: NOW});
  assert.equal(result.checks[0].code, "MONTHLY_CONTENT_FUTURE");
  assert.throws(() => monthlyReport({content: [{...CONTENT[0], updatedAt: "2026-02-30"}], expiry: EXPIRY, now: NOW}),
    /MONTHLY_DATE/u);
});

test("内容提取复用解码接口，公开项目和文章可见，草稿不泄露", async (t) => {
  const f = fixture(t);
  writeFileSync(resolve(f.root, "site-content/writing/.gitkeep"), "");
  const content = await collectContentDates(f);
  assert.equal(content.length, 2);
  assert.equal(content[1].id, f.published.articleId);
  assert.ok(!JSON.stringify(content).includes("private"));
});

test("文章目录符号链接和两个入口不能被当作成功", async (t) => {
  const f = fixture(t);
  const alias = resolve(f.root, "site-content/writing/alias");
  symlinkSync(resolve(f.root, "site-content/writing/published"), alias);
  await assert.rejects(collectContentDates(f), /MONTHLY_DIRECTORY/u);
  rmSync(alias);
  writeFileSync(resolve(f.root, "site-content/writing/published/index.mdx"), "{}");
  await assert.rejects(collectContentDates(f), /MONTHLY_ARTICLE_SOURCE/u);
});

test("解码期间已读注册表漂移时不发布混合快照", async (t) => {
  const f = fixture(t);
  await assert.rejects(collectContentDates({...f, decode: async (input) => {
    const decoded = await f.decode(input);
    writeFileSync(f.projectsPath, "{}");
    return decoded;
  }}), /MONTHLY_INPUT_DRIFT/u);
});

test("重复公开身份和缺失更新时间拒绝", async (t) => {
  const f = fixture(t);
  const projects = [{id: "same", publicationStatus: "published", updatedAt: "2026-01-01"}];
  writeFileSync(f.projectsPath, JSON.stringify({projects: [...projects, ...projects]}));
  await assert.rejects(collectContentDates(f), /MONTHLY_CONTENT_DUPLICATE/u);
  writeFileSync(f.projectsPath, JSON.stringify({projects: [{id: "same", publicationStatus: "published"}]}));
  await assert.rejects(collectContentDates(f), /MONTHLY_DATE/u);
});

test("CLI 拒绝不安全私有记录和错误参数，输出不含原始异常", async (t) => {
  const f = fixture(t);
  const expiryPath = resolve(f.root, "private-expiry.json");
  const outputPath = resolve(f.root, "result.json");
  writeFileSync(expiryPath, JSON.stringify(EXPIRY));
  chmodSync(expiryPath, 0o644);
  assert.equal(await main(["--expiry", expiryPath, "--output", outputPath]), 1);
  assert.equal(await main(["--wrong", expiryPath, "--output", outputPath]), 1);
  assert.equal(readFileSync(expiryPath, "utf8"), JSON.stringify(EXPIRY));
});
