import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {once} from "node:events";
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {generateSupplyChainArtifacts, publishSpdxArtifacts, recoverSpdxPublication} from "../../scripts/quality/lib/supply-chain/sbom-artifacts.mjs";
import {publicationJournalPath} from "../../scripts/quality/lib/supply-chain/publication-recovery.mjs";
import {displaceDeadGenerationLock} from "../../scripts/quality/lib/supply-chain/generation-lock.mjs";

const MODULE = new URL("../../scripts/quality/lib/supply-chain/sbom-artifacts.mjs", import.meta.url).href;
const LOCK_MODULE = new URL("../../scripts/quality/lib/supply-chain/generation-lock.mjs", import.meta.url).href;
const RECOVERY_MODULE = new URL("../../scripts/quality/lib/supply-chain/publication-recovery.mjs", import.meta.url).href;
const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const old = {evidenceBytes: "old evidence\n", bytes: "old sbom\n"};
const next = {evidenceBytes: "new evidence\n", bytes: "new sbom\n"};

function fixture(initial = true) {
  const root = mkdtempSync("/tmp/axial-spdx-recovery-");
  const artifactDirectory = join(root, "generated", "supply-chain");
  const noticePath = join(root, "THIRD_PARTY_NOTICES");
  mkdirSync(join(root, "generated"));
  const options = {artifactDirectory, noticePath, result: old, expectedPrevious: null,
    noticeBytes: "old notices\n", expectedPreviousNotice: null};
  if (initial) publishSpdxArtifacts(options);
  return {root, artifactDirectory, noticePath, options, update: {...options, result: next,
    expectedPrevious: initial ? {evidenceBytes: old.evidenceBytes, sbomBytes: old.bytes} : null,
    noticeBytes: "new notices\n", expectedPreviousNotice: initial ? "old notices\n" : null}};
}

function killAt(f, point, {recover = false, afterActivate = false} = {}) {
  const functionName = recover ? "recoverSpdxPublication" : "publishSpdxArtifacts";
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {${functionName}} from ${JSON.stringify(MODULE)};
     ${functionName}({...${JSON.stringify(f.update)},
       afterDurableStep(step) {if(step === ${JSON.stringify(point)}) process.kill(process.pid, 'SIGKILL');},
       afterActivate() {${afterActivate ? "process.kill(process.pid, 'SIGKILL');" : ""}}
     });`], {encoding: "utf8", timeout: 10000});
  assert.equal(child.signal, "SIGKILL", `${point}: ${child.stderr}`);
}

function assertGeneration(f, generation) {
  if (generation === null) {
    assert.equal(existsSync(f.artifactDirectory), false);
    assert.equal(existsSync(f.noticePath), false);
    return;
  }
  assert.equal(readFileSync(join(f.artifactDirectory, "sbom.spdx.json"), "utf8"), generation.bytes);
  assert.equal(readFileSync(join(f.artifactDirectory, "dependency-evidence.json"), "utf8"), generation.evidenceBytes);
  assert.equal(readFileSync(f.noticePath, "utf8"), generation === old ? "old notices\n" : "new notices\n");
}

test("direct generation rejects an invalid runtime before touching a pending transaction", () => {
  const f = fixture();
  try {
    killAt(f, "", {afterActivate: true});
    const journal = publicationJournalPath(f.artifactDirectory);
    const beforeJournal = readFileSync(journal);
    const beforeEntries = readdirSync(join(f.root, "generated")).sort();
    assertGeneration(f, next);
    assert.throws(() => generateSupplyChainArtifacts({root: PROJECT_ROOT,
      artifactDirectory: f.artifactDirectory, noticePath: f.noticePath,
      nodeVersion: "0.0.0"}), {code: "NPM_RUNTIME_PROCESS"});
    assert.deepEqual(readFileSync(journal), beforeJournal);
    assert.deepEqual(readdirSync(join(f.root, "generated")).sort(), beforeEntries);
    assertGeneration(f, next);
  } finally { rmSync(f.root, {recursive: true, force: true}); }
});

test("direct generation on the minimum endpoint leaves a pending transaction untouched", {
  skip: process.versions.node !== "24.16.0",
}, () => {
  const f = fixture();
  try {
    killAt(f, "", {afterActivate: true});
    const journal = publicationJournalPath(f.artifactDirectory);
    const beforeJournal = readFileSync(journal);
    assert.throws(() => generateSupplyChainArtifacts({root: PROJECT_ROOT,
      artifactDirectory: f.artifactDirectory, noticePath: f.noticePath}), {code: "SPDX_PRIMARY_ONLY"});
    assert.deepEqual(readFileSync(journal), beforeJournal);
    assertGeneration(f, next);
  } finally { rmSync(f.root, {recursive: true, force: true}); }
});

for (const point of ["journal-prepared-renamed", "journal-prepared", "backup-artifact-renamed", "backup-artifact",
  "backup-notice-renamed", "backup-notice", "activate-artifact-renamed", "activate-artifact",
  "activate-notice-renamed", "activate-notice", "journal-committed-renamed", "journal-committed", "retire-artifact-renamed",
  "retire-artifact", "cleanup-supply-chain-dependency-evidence.json-unlinked",
  "cleanup-supply-chain-sbom.spdx.json-unlinked", "cleanup-supply-chain-removed",
  "retire-notice-renamed", "cleanup-THIRD_PARTY_NOTICES-removed", "container-0-removed",
  "container-1-removed", "container-2-removed", "journal-removed"]) {
  test(`SIGKILL at ${point} recovers one complete generation`, () => {
    const f = fixture();
    try {
      killAt(f, point);
      recoverSpdxPublication(f);
      const committed = ["journal-committed-renamed", "journal-committed", "retire-artifact-renamed", "retire-artifact",
        "cleanup-supply-chain-dependency-evidence.json-unlinked", "cleanup-supply-chain-sbom.spdx.json-unlinked",
        "cleanup-supply-chain-removed", "retire-notice-renamed", "cleanup-THIRD_PARTY_NOTICES-removed",
        "container-0-removed", "container-1-removed", "container-2-removed", "journal-removed"].includes(point);
      assertGeneration(f, committed ? next : old);
      assert.equal(existsSync(publicationJournalPath(f.artifactDirectory)), false);
      recoverSpdxPublication(f);
      assertGeneration(f, committed ? next : old);
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });
}

for (const point of ["rollback-0-renamed", "rollback-0", "rollback-1-renamed", "restore-0-renamed",
  "restore-1", "journal-rolled-back-renamed", "journal-rolled-back", "cleanup-supply-chain-dependency-evidence.json-unlinked",
  "cleanup-THIRD_PARTY_NOTICES-removed", "container-0-removed", "container-2-removed"]) {
  test(`recovery itself survives SIGKILL at ${point}`, () => {
    const f = fixture();
    try {
      killAt(f, "", {afterActivate: true});
      killAt(f, point, {recover: true});
      recoverSpdxPublication(f);
      assertGeneration(f, old);
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });
}

for (const committed of [false, true]) {
  test(`first publication recovers ${committed ? "committed" : "uncommitted"} state`, () => {
    const f = fixture(false);
    try {
      killAt(f, committed ? "journal-committed" : "activate-artifact-renamed");
      recoverSpdxPublication(f);
      assertGeneration(f, committed ? next : null);
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });
}

for (const replacement of ["notice-content", "notice-inode", "child-inode", "extra", "journal", "parent"]) {
  test(`recovery preserves drifted ${replacement} and both backups`, () => {
    const f = fixture();
    try {
      killAt(f, "", {afterActivate: true});
      if (replacement === "notice-content") writeFileSync(f.noticePath, "external\n");
      if (replacement === "notice-inode") {
        renameSync(f.noticePath, f.noticePath + ".foreign-held");
        writeFileSync(f.noticePath, "new notices\n");
      }
      if (replacement === "child-inode") {
        const path = join(f.artifactDirectory, "sbom.spdx.json");
        renameSync(path, path + ".foreign-held");
        writeFileSync(path, next.bytes);
        unlinkSync(path + ".foreign-held");
      }
      if (replacement === "extra") writeFileSync(join(f.artifactDirectory, "external"), "foreign");
      if (replacement === "journal") writeFileSync(publicationJournalPath(f.artifactDirectory), "{partial");
      if (replacement === "parent") {
        renameSync(join(f.root, "generated"), join(f.root, "displaced"));
        mkdirSync(join(f.root, "generated"));
        renameSync(join(f.root, "displaced", "supply-chain"), f.artifactDirectory);
        for (const name of readdirSync(join(f.root, "displaced"))) {
          renameSync(join(f.root, "displaced", name), join(f.root, "generated", name));
        }
      }
      assert.throws(() => recoverSpdxPublication(f), {code: "SPDX_ARTIFACT_PUBLISH_UNCERTAIN"});
      assert.equal(readFileSync(join(f.root, "generated", ".supply-chain.backup", "sbom.spdx.json"), "utf8"), old.bytes);
      assert.equal(readFileSync(join(f.root, ".THIRD_PARTY_NOTICES.backup"), "utf8"), "old notices\n");
      assert.equal(readFileSync(join(f.artifactDirectory, "sbom.spdx.json"), "utf8"), next.bytes);
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });
}

test("live publication lock blocks a competing writer before recovery", () => {
  const f = fixture();
  try {
    publishSpdxArtifacts({...f.update, afterActivate() {
      assert.throws(() => publishSpdxArtifacts({artifactDirectory: f.artifactDirectory, result: old,
        expectedPrevious: {evidenceBytes: next.evidenceBytes, sbomBytes: next.bytes}}), {code: "SPDX_GENERATION_LOCKED"});
      const competing = spawnSync(process.execPath, ["--input-type=module", "-e",
        `import {recoverSpdxPublication} from ${JSON.stringify(MODULE)};
         try {recoverSpdxPublication(${JSON.stringify(f)}); process.exit(2);}
         catch(e) {if(e.code !== 'SPDX_GENERATION_LOCKED') throw e;}`], {encoding: "utf8", timeout: 10000});
      assert.equal(competing.status, 0, competing.stderr);
    }});
    assertGeneration(f, next);
  } finally { rmSync(f.root, {recursive: true, force: true}); }
});

test("the pair-only entry cannot bypass a pending triplet transaction", () => {
  const f = fixture();
  try {
    killAt(f, "", {afterActivate: true});
    assert.throws(() => publishSpdxArtifacts({artifactDirectory: f.artifactDirectory, result: old,
      expectedPrevious: {evidenceBytes: next.evidenceBytes, sbomBytes: next.bytes}}),
    {code: "SPDX_ARTIFACT_PUBLISH_UNCERTAIN"});
    assertGeneration(f, next);
    assert.equal(existsSync(publicationJournalPath(f.artifactDirectory)), true);
    recoverSpdxPublication(f);
    assertGeneration(f, old);
  } finally { rmSync(f.root, {recursive: true, force: true}); }
});

test("a killed owner between atomic lock publication and staging unlink is recoverable", () => {
  const f = fixture();
  const path = join(f.root, "generated", ".supply-chain.publication.generation.lock");
  try {
    const killed = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {createGenerationLock} from ${JSON.stringify(LOCK_MODULE)};
      import {syncPublicationDirectory} from ${JSON.stringify(RECOVERY_MODULE)};
      createGenerationLock(${JSON.stringify(path)}, 'LOCKED', syncPublicationDirectory);
      process.kill(process.pid, 'SIGKILL');`], {encoding: "utf8", timeout: 10000});
    assert.equal(killed.signal, "SIGKILL", killed.stderr);
    const owner = JSON.parse(readFileSync(path));
    const staging = join(f.root, "generated", `..supply-chain.publication.generation.lock.owner-${owner.nonce}`);
    linkSync(path, staging);
    assert.equal(lstatSync(path).nlink, 2);
    recoverSpdxPublication(f);
    assertGeneration(f, old);
    assert.equal(existsSync(path), false);
  } finally { rmSync(f.root, {recursive: true, force: true}); }
});

for (const field of ["boot", "namespace", "unknown"]) {
  test(`an invalid ${field} lock record is preserved instead of reclaimed`, () => {
    const f = fixture();
    const path = join(f.root, "generated", ".supply-chain.publication.generation.lock");
    try {
      const killed = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import {createGenerationLock} from ${JSON.stringify(LOCK_MODULE)};
        import {syncPublicationDirectory} from ${JSON.stringify(RECOVERY_MODULE)};
        createGenerationLock(${JSON.stringify(path)}, 'LOCKED', syncPublicationDirectory);
        process.kill(process.pid, 'SIGKILL');`], {encoding: "utf8", timeout: 10000});
      assert.equal(killed.signal, "SIGKILL", killed.stderr);
      const record = JSON.parse(readFileSync(path));
      record[field] = "invalid";
      const raw = JSON.stringify(record);
      writeFileSync(path, raw);
      assert.throws(() => recoverSpdxPublication(f), {code: "SPDX_GENERATION_LOCKED"});
      assert.equal(readFileSync(path, "utf8"), raw);
      assertGeneration(f, old);
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });
}

test("a stale-lock contender cannot admit a third writer after displacing a live successor", async () => {
  const f = fixture();
  const path = join(f.root, "generated", ".supply-chain.publication.generation.lock");
  const ready = join(f.root, "holder-ready");
  let holder;
  try {
    const killed = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {createGenerationLock} from ${JSON.stringify(LOCK_MODULE)};
      import {syncPublicationDirectory} from ${JSON.stringify(RECOVERY_MODULE)};
      createGenerationLock(${JSON.stringify(path)}, 'LOCKED', syncPublicationDirectory);
      process.kill(process.pid, 'SIGKILL');`], {encoding: "utf8", timeout: 10000});
    assert.equal(killed.signal, "SIGKILL", killed.stderr);
    assert.throws(() => displaceDeadGenerationLock(path, "SPDX_GENERATION_LOCKED", () => {
      if (holder) return;
      holder = spawn(process.execPath, ["--input-type=module", "-e", `
        import {createGenerationLock, assertNoLiveDisplacedLocks} from ${JSON.stringify(LOCK_MODULE)};
        import {syncPublicationDirectory} from ${JSON.stringify(RECOVERY_MODULE)};
        import {writeFileSync} from 'node:fs';
        createGenerationLock(${JSON.stringify(path)}, 'LOCKED', syncPublicationDirectory);
        assertNoLiveDisplacedLocks(${JSON.stringify(path)}, 'LOCKED');
        writeFileSync(${JSON.stringify(ready)}, 'ready');
        setInterval(() => {}, 1000);`], {stdio: "ignore"});
      const deadline = Date.now() + 5000;
      while (!existsSync(ready)) {
        assert.ok(Date.now() < deadline, "successor did not acquire the stale lock");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }), {code: "SPDX_GENERATION_LOCKED"});
    assert.equal(existsSync(path), false);
    assert.throws(() => recoverSpdxPublication(f), {code: "SPDX_GENERATION_LOCKED"});
    holder.kill("SIGKILL");
    await once(holder, "exit");
    recoverSpdxPublication(f);
    assertGeneration(f, old);
  } finally {
    if (holder && holder.exitCode === null && holder.signalCode === null) {
      holder.kill("SIGKILL");
      await once(holder, "exit");
    }
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("a killed triplet publisher can be retried from the old generation", () => {
  const root = mkdtempSync("/tmp/axial-spdx-recovery-");
  const artifactDirectory = join(root, "generated", "supply-chain");
  const noticePath = join(root, "THIRD_PARTY_NOTICES");
  mkdirSync(join(root, "generated"));
  const options = {artifactDirectory, noticePath, result: old, expectedPrevious: null,
    noticeBytes: "old notices\n", expectedPreviousNotice: null};
  try {
    publishSpdxArtifacts(options);
    const update = {...options, result: next,
      expectedPrevious: {evidenceBytes: old.evidenceBytes, sbomBytes: old.bytes},
      noticeBytes: "new notices\n", expectedPreviousNotice: "old notices\n"};
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import {publishSpdxArtifacts} from ${JSON.stringify(MODULE)};
       publishSpdxArtifacts({...${JSON.stringify(update)}, afterActivate() {process.kill(process.pid, 'SIGKILL');}});`],
    {encoding: "utf8", timeout: 10000});
    assert.equal(child.signal, "SIGKILL", child.stderr);
    publishSpdxArtifacts(update);
    assert.equal(readFileSync(join(artifactDirectory, "sbom.spdx.json"), "utf8"), next.bytes);
    assert.equal(readFileSync(noticePath, "utf8"), "new notices\n");
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
