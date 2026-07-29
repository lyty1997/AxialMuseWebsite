import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import test from "node:test";
import {
  assertCheckReleaseArguments,
  runCheckReleaseCli,
} from "../../scripts/quality/check-release-package.mjs";
import {
  captureFileTree,
} from "../../scripts/quality/lib/file-tree.mjs";
import {
  assertPackageSiteArguments,
  runPackageSiteCli,
} from "../../scripts/release/package-site.mjs";
import {
  checkReleasePackage,
  digestPublicRoutes,
  formatReleasePackageError,
  packageSite,
  RELEASE_FILES_PATH,
  RELEASE_JSON_PATH,
  RELEASE_NGINX_REDIRECTS_PATH,
  RELEASE_RUNTIME_REDIRECTS_PATH,
  RELEASE_SCHEMA_VERSION,
  RELEASE_REPOSITORY,
  ReleasePackageError,
} from "../../scripts/release/lib/release-package.mjs";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const RELEASE_MODULE_URL = pathToFileURL(resolve(
  TEST_DIRECTORY,
  "../../scripts/release/lib/release-package.mjs",
)).href;

function hasCode(code) {
  return (error) => (
    error instanceof ReleasePackageError
    && error.code === code
  );
}

function writeFixture(root, relativePath, bytes) {
  const path = resolve(root, relativePath);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, bytes);
}

function runGit(root, arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function createRepositoryFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-release-package-"));
  try {
    writeFixture(root, ".gitignore", "build/\ndist/\nvictim.txt\n");
    writeFixture(
      root,
      "docs/contracts/redirects.json",
      `${JSON.stringify({
        version: "0.1.0",
        kind: "axial_muse_redirects",
        status: "active",
        owner: "AxialMuseWebsite",
        redirects: [{
          from: "/old/",
          to: "/projects/",
          reason: "release fixture",
        }],
      }, null, 2)}\n`,
    );
    runGit(root, ["init", "-q"]);
    runGit(root, ["config", "user.name", "Release Fixture"]);
    runGit(root, ["config", "user.email", "release@example.invalid"]);
    runGit(root, ["add", ".gitignore", "docs/contracts/redirects.json"]);
    runGit(root, ["commit", "-q", "-m", "fixture"]);

    writeFixture(root, "build/index.html", "<!doctype html>\n");
    writeFixture(
      root,
      "build/projects/index.html",
      "<!doctype html><title>projects</title>\n",
    );
    writeFixture(root, "build/assets/app.js", "console.log(\"fixture\");\n");
    writeFixture(
      root,
      "build/sitemap.xml",
      "<?xml version=\"1.0\"?><urlset></urlset>\n",
    );
    return callback(root);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function captureOutput() {
  let value = "";
  return {
    stream: {
      write(chunk) {
        value += chunk;
      },
    },
    value() {
      return value;
    },
  };
}

function verifyFixtureProductionBuild() {}

function packageFixture(root, testHooks) {
  return packageSite({
    repositoryRoot: root,
    verifyProductionBuild: verifyFixtureProductionBuild,
    ...(testHooks === undefined ? {} : {testHooks}),
  });
}

function checkFixture(root, testHooks) {
  return checkReleasePackage({
    repositoryRoot: root,
    verifyProductionBuild: verifyFixtureProductionBuild,
    ...(testHooks === undefined ? {} : {testHooks}),
  });
}

function candidatePath(root) {
  const candidates = readdirSync(resolve(root, "dist"))
    .filter((entry) => entry.startsWith(".release-candidate-"));
  assert.equal(candidates.length, 1);
  return resolve(root, "dist", candidates[0]);
}

test("#33 正常封装、确定性 metadata 与 fresh-process 独立复验", () => {
  createRepositoryFixture((root) => {
    const packageOutput = captureOutput();
    const packaged = runPackageSiteCli({
      root,
      cwd: root,
      standardOutput: packageOutput.stream,
      verifyProductionBuild: verifyFixtureProductionBuild,
    });
    assert.match(
      packageOutput.value(),
      /^Release package created: commitSha=[0-9a-f]{40} sourceBuildTreeSha256=[0-9a-f]{64}\n$/u,
    );
    assert.equal(packaged.releaseFileCount, 8);

    const checkOutput = captureOutput();
    const checked = runCheckReleaseCli({
      root,
      cwd: root,
      standardOutput: checkOutput.stream,
      verifyProductionBuild: verifyFixtureProductionBuild,
    });
    assert.equal(
      checkOutput.value(),
      `releaseContentSha256=${checked.releaseContentSha256}\n`,
    );
    assert.match(checked.releaseContentSha256, /^[0-9a-f]{64}$/u);

    const metadataBytes = readFileSync(resolve(root, "dist/release", RELEASE_JSON_PATH));
    const metadata = JSON.parse(metadataBytes);
    assert.deepEqual(Object.keys(metadata), [
      "schemaVersion",
      "repository",
      "commitSha",
      "payloadRoot",
      "sourceBuildTreeSha256",
      "redirectRegistrySha256",
      "publicRoutesSha256",
      "runtimeRedirectsSha256",
      "nginxRedirectsSha256",
      "registeredRuleCount",
      "canonicalSlashRuleCount",
      "ruleCount",
      "filesSha256",
      "fileCount",
    ]);
    assert.equal(metadata.schemaVersion, RELEASE_SCHEMA_VERSION);
    assert.equal(metadata.repository, RELEASE_REPOSITORY);
    assert.equal(metadata.commitSha, packaged.commitSha);
    assert.equal(metadata.payloadRoot, "payload");
    assert.equal(metadata.sourceBuildTreeSha256, packaged.sourceBuildTreeSha256);
    assert.equal(metadata.publicRoutesSha256, digestPublicRoutes([
      "/",
      "/projects/",
    ]));
    assert.equal(metadata.registeredRuleCount, 2);
    assert.equal(metadata.canonicalSlashRuleCount, 1);
    assert.equal(metadata.ruleCount, 3);
    assert.equal(metadata.fileCount, 6);
    assert.equal(Object.hasOwn(metadata, "releaseContentSha256"), false);
    assert.doesNotMatch(metadataBytes.toString("utf8"), /\/tmp\/|\/home\//u);

    const filesBytes = readFileSync(
      resolve(root, "dist/release", RELEASE_FILES_PATH),
    );
    const fileLines = filesBytes.toString("utf8").trimEnd().split("\n");
    assert.equal(fileLines.length, metadata.fileCount);
    assert.equal(sha256(filesBytes), metadata.filesSha256);
    assert.deepEqual(fileLines.map((line) => line.slice(66)), [
      "metadata/nginx/redirects.conf",
      "metadata/runtime-redirects.json",
      "payload/assets/app.js",
      "payload/index.html",
      "payload/projects/index.html",
      "payload/sitemap.xml",
    ]);

    const runtime = JSON.parse(readFileSync(
      resolve(root, "dist/release", RELEASE_RUNTIME_REDIRECTS_PATH),
      "utf8",
    ));
    assert.equal(runtime.rules.length, 3);
    assert.equal(JSON.stringify(runtime).includes("reason"), false);
    assert.equal(
      sha256(readFileSync(
        resolve(root, "dist/release", RELEASE_NGINX_REDIRECTS_PATH),
      )),
      metadata.nginxRedirectsSha256,
    );

    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import {checkReleasePackage} from ${JSON.stringify(RELEASE_MODULE_URL)};`
          + `const result=checkReleasePackage({repositoryRoot:${JSON.stringify(root)},verifyProductionBuild(){}});`
          + "process.stdout.write(`releaseContentSha256=${result.releaseContentSha256}\\n`);",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, checkOutput.value());

    const firstReleaseBytes = captureFileTree({
      root: resolve(root, "dist/release"),
      sourcePath: "dist/release",
    }).treeSha256;
    const firstMetadata = Buffer.from(metadataBytes);
    rmSync(resolve(root, "dist"), {recursive: true, force: false});
    packageFixture(root);
    const second = checkFixture(root);
    assert.equal(second.releaseContentSha256, firstReleaseBytes);
    assert.deepEqual(
      readFileSync(resolve(root, "dist/release", RELEASE_JSON_PATH)),
      firstMetadata,
    );
  });
});

test("#33 Git 工作区与既有 dist 状态失败关闭", async (t) => {
  await t.test("dirty tracked input", () => {
    createRepositoryFixture((root) => {
      writeFixture(
        root,
        ".gitignore",
        "build/\ndist/\nvictim.txt\ntracked-drift\n",
      );
      assert.throws(() => packageFixture(root), hasCode("RELEASE_PACKAGE_WORKSPACE"));
      assert.equal(existsSync(resolve(root, "dist")), false);
    });
  });

  await t.test("dirty untracked input", () => {
    createRepositoryFixture((root) => {
      writeFixture(root, "untracked.txt", "untracked\n");
      assert.throws(() => packageFixture(root), hasCode("RELEASE_PACKAGE_WORKSPACE"));
      assert.equal(existsSync(resolve(root, "dist")), false);
    });
  });

  await t.test("HEAD changes after initial capture", () => {
    createRepositoryFixture((root) => {
      assert.throws(
        () => packageFixture(root, {
          afterInitialBuildCapture() {
            writeFixture(root, "head-drift.txt", "new commit\n");
            runGit(root, ["add", "head-drift.txt"]);
            runGit(root, ["commit", "-q", "-m", "head drift"]);
          },
        }),
        hasCode("RELEASE_PACKAGE_COMMIT"),
      );
      assert.equal(existsSync(resolve(root, "dist")), false);
    });
  });

  await t.test("non-repository root", () => {
    const root = mkdtempSync(join(tmpdir(), "axial-muse-release-non-git-"));
    try {
      writeFixture(root, "build/index.html", "<!doctype html>\n");
      writeFixture(
        root,
        "build/sitemap.xml",
        "<?xml version=\"1.0\"?><urlset></urlset>\n",
      );
      writeFixture(
        root,
        "docs/contracts/redirects.json",
        "{\"version\":\"0.1.0\"}\n",
      );
      assert.throws(() => packageFixture(root), hasCode("RELEASE_PACKAGE_WORKSPACE"));
      assert.equal(existsSync(resolve(root, "dist")), false);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  await t.test("bare repository root", () => {
    const root = mkdtempSync(join(tmpdir(), "axial-muse-release-bare-"));
    try {
      runGit(root, ["init", "--bare", "-q"]);
      writeFixture(root, "build/index.html", "<!doctype html>\n");
      writeFixture(
        root,
        "build/sitemap.xml",
        "<?xml version=\"1.0\"?><urlset></urlset>\n",
      );
      writeFixture(
        root,
        "docs/contracts/redirects.json",
        "{\"version\":\"0.1.0\"}\n",
      );
      assert.throws(() => packageFixture(root), hasCode("RELEASE_PACKAGE_WORKSPACE"));
      assert.equal(existsSync(resolve(root, "dist")), false);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  for (const fixtureCase of [
    {
      name: "unknown dist member",
      prepare(root) {
        mkdirSync(resolve(root, "dist"), {mode: 0o700});
        writeFixture(root, "dist/foreign.txt", "foreign\n");
      },
      preservedPath: "dist/foreign.txt",
    },
    {
      name: "pre-existing release",
      prepare(root) {
        mkdirSync(resolve(root, "dist/release"), {
          recursive: true,
          mode: 0o700,
        });
      },
      preservedPath: "dist/release",
    },
    {
      name: "non-private empty dist",
      prepare(root) {
        mkdirSync(resolve(root, "dist"), {mode: 0o755});
      },
      preservedPath: "dist",
    },
  ]) {
    await t.test(fixtureCase.name, () => {
      createRepositoryFixture((root) => {
        fixtureCase.prepare(root);
        assert.throws(() => packageFixture(root), hasCode("RELEASE_PACKAGE_DIST"));
        assert.equal(existsSync(resolve(root, fixtureCase.preservedPath)), true);
      });
    });
  }
});

test("#33 封装检测增删改、A→B→A 与 build root 替换且不留下 release", async (t) => {
  const cases = [
    {
      name: "persistent add",
      hooks(root) {
        return {
          afterInitialBuildCapture() {
            writeFixture(root, "build/late.txt", "late\n");
          },
        };
      },
      code: "RELEASE_PACKAGE_COPY",
    },
    {
      name: "persistent delete",
      hooks(root) {
        return {
          afterInitialBuildCapture() {
            rmSync(resolve(root, "build/assets/app.js"));
          },
        };
      },
      code: "RELEASE_PACKAGE_COPY",
    },
    {
      name: "persistent rename",
      hooks(root) {
        return {
          afterInitialBuildCapture() {
            renameSync(
              resolve(root, "build/assets/app.js"),
              resolve(root, "build/assets/renamed.js"),
            );
          },
        };
      },
      code: "RELEASE_PACKAGE_COPY",
    },
    {
      name: "persistent byte change",
      hooks(root) {
        return {
          afterInitialBuildCapture() {
            writeFileSync(resolve(root, "build/index.html"), "changed\n");
          },
        };
      },
      code: "RELEASE_PACKAGE_COPY",
    },
    {
      name: "A to B to A",
      hooks(root) {
        const path = resolve(root, "build/index.html");
        const original = readFileSync(path);
        return {
          afterInitialBuildCapture() {
            writeFileSync(path, "changed\n");
            writeFileSync(path, original);
          },
        };
      },
      code: "RELEASE_PACKAGE_COPY",
    },
    {
      name: "same-byte new build root",
      hooks(root) {
        return {
          afterInitialBuildCapture() {
            const build = resolve(root, "build");
            const old = resolve(root, "build-old");
            renameSync(build, old);
            cpSync(old, build, {recursive: true, preserveTimestamps: true});
          },
        };
      },
      code: "RELEASE_PACKAGE_COPY",
    },
    {
      name: "mutation before activation",
      hooks(root) {
        const path = resolve(root, "build/index.html");
        const original = readFileSync(path);
        return {
          beforeActivation() {
            writeFileSync(path, "changed\n");
            writeFileSync(path, original);
          },
        };
      },
      code: "RELEASE_PACKAGE_CHANGED",
    },
    {
      name: "release A to B to A after activation",
      hooks(root) {
        return {
          afterActivation() {
            const path = resolve(root, "dist/release/payload/index.html");
            const original = readFileSync(path);
            writeFileSync(path, "changed\n");
            writeFileSync(path, original);
          },
        };
      },
      code: "RELEASE_PACKAGE_ACTIVATE",
    },
    {
      name: "build A to B to A after activation",
      hooks(root) {
        return {
          afterActivation() {
            const path = resolve(root, "build/index.html");
            const original = readFileSync(path);
            writeFileSync(path, "changed\n");
            writeFileSync(path, original);
          },
        };
      },
      code: "RELEASE_PACKAGE_CHANGED",
    },
    {
      name: "registry A to B to A after activation",
      hooks(root) {
        return {
          afterActivation() {
            const path = resolve(root, "docs/contracts/redirects.json");
            const original = readFileSync(path);
            const alternate = Buffer.from(
              original.toString("utf8").replace(
                "release fixture",
                "temporary reason",
              ),
              "utf8",
            );
            writeFileSync(path, alternate);
            writeFileSync(path, original);
          },
        };
      },
      code: "RELEASE_PACKAGE_CHANGED",
    },
  ];
  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, () => {
      createRepositoryFixture((root) => {
        assert.throws(
          () => packageFixture(root, fixtureCase.hooks(root)),
          hasCode(fixtureCase.code),
        );
        assert.equal(existsSync(resolve(root, "dist/release")), false);
      });
    });
  }
});

test("#33 production verifier 必须成功且不得改变 build/registry", async (t) => {
  const cases = [
    {
      name: "throws",
      verify() {
        throw new Error("synthetic verifier failure");
      },
    },
    {
      name: "returns a value",
      verify() {
        return true;
      },
    },
    {
      name: "mutates build A to B to A",
      verify(root) {
        const path = resolve(root, "build/index.html");
        const original = readFileSync(path);
        writeFileSync(path, "changed\n");
        writeFileSync(path, original);
      },
    },
    {
      name: "mutates registry A to B to A",
      verify(root) {
        const path = resolve(root, "docs/contracts/redirects.json");
        const original = readFileSync(path);
        writeFileSync(
          path,
          original.toString("utf8").replace(
            "release fixture",
            "temporary reason",
          ),
        );
        writeFileSync(path, original);
      },
    },
  ];
  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, () => {
      createRepositoryFixture((root) => {
        assert.throws(
          () => packageSite({
            repositoryRoot: root,
            verifyProductionBuild() {
              return fixtureCase.verify(root);
            },
          }),
          hasCode("RELEASE_PACKAGE_PRODUCTION"),
        );
        assert.equal(existsSync(resolve(root, "dist")), false);
      });
    });
  }
});

test("#33 候选同字节替换、树外 symlink 与不确定清理均保留现场", async (t) => {
  for (const hookName of ["afterDistPrepared", "afterCandidateCreated"]) {
    await t.test(`${hookName} setup failure cleans owned output`, () => {
      createRepositoryFixture((root) => {
        assert.throws(
          () => packageFixture(root, {
            [hookName]() {
              throw new Error("synthetic setup failure");
            },
          }),
          hasCode("RELEASE_PACKAGE_WRITE"),
        );
        assert.equal(existsSync(resolve(root, "dist")), false);
      });
    });
  }

  await t.test("activation reservation setup failure removes owned placeholder", () => {
    createRepositoryFixture((root) => {
      mkdirSync(resolve(root, "dist"), {mode: 0o700});
      assert.throws(
        () => packageFixture(root, {
          afterActivationReservationCreated() {
            throw new Error("synthetic reservation setup failure");
          },
        }),
        hasCode("RELEASE_PACKAGE_ACTIVATE"),
      );
      assert.deepEqual(readdirSync(resolve(root, "dist")), []);
    });
  });

  await t.test("unknown member in created dist remains cleanup-uncertain", () => {
    createRepositoryFixture((root) => {
      assert.throws(
        () => packageFixture(root, {
          afterDistPrepared() {
            writeFileSync(resolve(root, "dist/external-member"), "external\n");
            throw new Error("synthetic setup failure");
          },
        }),
        hasCode("RELEASE_PACKAGE_CLEANUP_UNCERTAIN"),
      );
      assert.equal(
        readFileSync(resolve(root, "dist/external-member"), "utf8"),
        "external\n",
      );
    });
  });

  await t.test("replaced created dist remains cleanup-uncertain", () => {
    createRepositoryFixture((root) => {
      const original = resolve(root, "dist-original");
      assert.throws(
        () => packageFixture(root, {
          afterDistPrepared() {
            renameSync(resolve(root, "dist"), original);
            mkdirSync(resolve(root, "dist"), {mode: 0o700});
            throw new Error("synthetic setup failure");
          },
        }),
        hasCode("RELEASE_PACKAGE_CLEANUP_UNCERTAIN"),
      );
      assert.equal(existsSync(original), true);
      assert.equal(existsSync(resolve(root, "dist")), true);
    });
  });

  await t.test("payload leaf same-byte new inode", () => {
    createRepositoryFixture((root) => {
      assert.throws(
        () => packageFixture(root, {
          afterFileCopied({relativePath}) {
            if (relativePath !== "index.html") return;
            const target = resolve(
              candidatePath(root),
              "payload/index.html",
            );
            const original = readFileSync(target);
            const replacement = `${target}.replacement`;
            writeFileSync(replacement, original);
            chmodSync(replacement, 0o600);
            renameSync(replacement, target);
          },
        }),
        hasCode("RELEASE_PACKAGE_CLEANUP_UNCERTAIN"),
      );
      const members = readdirSync(resolve(root, "dist"));
      assert.equal(members.includes("release"), false);
      assert.equal(
        members.filter((entry) => entry.startsWith(".release-failed-")).length,
        1,
      );
    });
  });

  await t.test("whole candidate same-byte new inode", () => {
    createRepositoryFixture((root) => {
      let oldCandidate;
      assert.throws(
        () => packageFixture(root, {
          afterArtifactsWritten() {
            const candidate = candidatePath(root);
            oldCandidate = `${candidate}-old`;
            renameSync(candidate, oldCandidate);
            cpSync(oldCandidate, candidate, {
              recursive: true,
              preserveTimestamps: true,
            });
          },
        }),
        hasCode("RELEASE_PACKAGE_CLEANUP_UNCERTAIN"),
      );
      assert.equal(existsSync(oldCandidate), true);
      assert.equal(existsSync(resolve(root, "dist/release")), false);
    });
  });

  await t.test("symlink target never chmods outside victim", () => {
    createRepositoryFixture((root) => {
      const victim = resolve(root, "victim.txt");
      writeFileSync(victim, "victim\n");
      chmodSync(victim, 0o644);
      assert.throws(
        () => packageFixture(root, {
          afterTargetCopiedBeforeSync({relativePath}) {
            if (relativePath !== "index.html") return;
            const target = resolve(
              candidatePath(root),
              "payload/index.html",
            );
            rmSync(target);
            symlinkSync(victim, target);
          },
        }),
        hasCode("RELEASE_PACKAGE_CLEANUP_UNCERTAIN"),
      );
      assert.equal(Number(lstatSync(victim).mode & 0o777), 0o644);
      assert.equal(existsSync(resolve(root, "dist/release")), false);
    });
  });

  await t.test("missing candidate path is uncertain", () => {
    createRepositoryFixture((root) => {
      let stolen;
      assert.throws(
        () => packageFixture(root, {
          afterArtifactsWritten() {
            const candidate = candidatePath(root);
            stolen = resolve(root, "dist/stolen");
            renameSync(candidate, stolen);
          },
        }),
        hasCode("RELEASE_PACKAGE_CLEANUP_UNCERTAIN"),
      );
      assert.equal(existsSync(stolen), true);
      assert.equal(existsSync(resolve(root, "dist/release")), false);
    });
  });

  await t.test("unknown candidate member is quarantined, not deleted", () => {
    createRepositoryFixture((root) => {
      assert.throws(
        () => packageFixture(root, {
          afterArtifactsWritten() {
            writeFileSync(
              resolve(candidatePath(root), "external-member"),
              "external\n",
            );
          },
        }),
        hasCode("RELEASE_PACKAGE_CLEANUP_UNCERTAIN"),
      );
      const failed = readdirSync(resolve(root, "dist"))
        .find((entry) => entry.startsWith(".release-failed-"));
      assert.ok(failed);
      assert.equal(
        readFileSync(
          resolve(root, "dist", failed, "external-member"),
          "utf8",
        ),
        "external\n",
      );
    });
  });

  await t.test("activation reservation replacement is never overwritten", () => {
    createRepositoryFixture((root) => {
      const competitor = resolve(root, "dist/release");
      assert.throws(
        () => packageFixture(root, {
          afterActivationReservation() {
            const replacement = resolve(root, "dist/competitor");
            mkdirSync(replacement, {mode: 0o700});
            rmSync(competitor, {recursive: true});
            renameSync(replacement, competitor);
          },
        }),
        hasCode("RELEASE_PACKAGE_CLEANUP_UNCERTAIN"),
      );
      assert.equal(existsSync(competitor), true);
      assert.deepEqual(readdirSync(competitor), []);
    });
  });
});

test("#33 public route wire 使用独立固定 golden", () => {
  assert.equal(
    digestPublicRoutes(["/", "/projects/", "/writing/非ASCII/"]),
    "88ec45c8748d0c7490cdd6ebea52757086d82377cd03503e65a19aefa745bdb1",
  );
  assert.throws(
    () => digestPublicRoutes(["/projects/", "/"]),
    hasCode("RELEASE_PACKAGE_INPUT"),
  );
});

test("#33 checker 从 build/registry 重建并拒绝派生、清单与 metadata 篡改", async (t) => {
  const cases = [
    {
      name: "runtime redirects",
      path: RELEASE_RUNTIME_REDIRECTS_PATH,
      bytes: "{}\n",
      code: "RELEASE_PACKAGE_DERIVED",
    },
    {
      name: "nginx redirects",
      path: RELEASE_NGINX_REDIRECTS_PATH,
      bytes: "location = /forged { return 302 /; }\n",
      code: "RELEASE_PACKAGE_DERIVED",
    },
    {
      name: "files manifest",
      path: RELEASE_FILES_PATH,
      bytes: "",
      code: "RELEASE_PACKAGE_MANIFEST",
    },
    {
      name: "release metadata",
      path: RELEASE_JSON_PATH,
      bytes: "{}\n",
      code: "RELEASE_PACKAGE_METADATA",
    },
  ];
  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, () => {
      createRepositoryFixture((root) => {
        packageFixture(root);
        writeFileSync(
          resolve(root, "dist/release", fixtureCase.path),
          fixtureCase.bytes,
        );
        assert.throws(
          () => checkFixture(root),
          hasCode(fixtureCase.code),
        );
      });
    });
  }
});

test("#33 内部自洽的 payload/清单/metadata 伪造仍不能脱离 source build", () => {
  createRepositoryFixture((root) => {
    packageFixture(root);
    const releaseRoot = resolve(root, "dist/release");
    const payloadRoot = resolve(releaseRoot, "payload");
    const target = resolve(payloadRoot, "index.html");
    writeFileSync(target, "<!doctype html><title>forged</title>\n");

    const filesPath = resolve(releaseRoot, RELEASE_FILES_PATH);
    const forgedHash = sha256(readFileSync(target));
    const lines = readFileSync(filesPath, "utf8").trimEnd().split("\n")
      .map((line) => (
        line.endsWith("  payload/index.html")
          ? `${forgedHash}  payload/index.html`
          : line
      ));
    const filesBytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    writeFileSync(filesPath, filesBytes);

    const metadataPath = resolve(releaseRoot, RELEASE_JSON_PATH);
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    metadata.sourceBuildTreeSha256 = captureFileTree({
      root: payloadRoot,
      sourcePath: "payload",
    }).treeSha256;
    metadata.filesSha256 = sha256(filesBytes);
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    assert.throws(
      () => checkFixture(root),
      hasCode("RELEASE_PACKAGE_COPY"),
    );
  });
});

test("#33 checker 输出前拒绝 build/registry 瞬时变化和整版 release 替换", async (t) => {
  await t.test("build A to B to A", () => {
    createRepositoryFixture((root) => {
      packageFixture(root);
      const path = resolve(root, "build/index.html");
      const original = readFileSync(path);
      assert.throws(
        () => checkFixture(root, {
            afterValidation() {
              writeFileSync(path, "changed\n");
              writeFileSync(path, original);
            },
        }),
        hasCode("RELEASE_PACKAGE_CHANGED"),
      );
    });
  });

  await t.test("registry A to B to A", () => {
    createRepositoryFixture((root) => {
      packageFixture(root);
      const path = resolve(root, "docs/contracts/redirects.json");
      const original = readFileSync(path);
      const alternate = Buffer.from(
        original.toString("utf8").replace("release fixture", "alternate"),
        "utf8",
      );
      assert.throws(
        () => checkFixture(root, {
            afterValidation() {
              writeFileSync(path, alternate);
              writeFileSync(path, original);
            },
        }),
        hasCode("RELEASE_PACKAGE_CHANGED"),
      );
    });
  });

  await t.test("same-byte new release root", () => {
    createRepositoryFixture((root) => {
      packageFixture(root);
      const release = resolve(root, "dist/release");
      const old = resolve(root, "dist/release-old");
      assert.throws(
        () => checkFixture(root, {
            afterValidation() {
              renameSync(release, old);
              cpSync(old, release, {
                recursive: true,
                preserveTimestamps: true,
              });
            },
        }),
        hasCode("RELEASE_PACKAGE_CHANGED"),
      );
    });
  });

  await t.test("dist sibling added after validation", () => {
    createRepositoryFixture((root) => {
      packageFixture(root);
      assert.throws(
        () => checkFixture(root, {
          afterValidation() {
            writeFileSync(resolve(root, "dist/extra"), "extra\n");
          },
        }),
        hasCode("RELEASE_PACKAGE_CHANGED"),
      );
    });
  });
});

test("#33 package 激活后出现 dist sibling 时移除 canonical 且保留外部成员", () => {
  createRepositoryFixture((root) => {
    assert.throws(
      () => packageFixture(root, {
        afterActivation() {
          writeFileSync(resolve(root, "dist/extra"), "extra\n");
        },
      }),
      (error) => (
        error instanceof ReleasePackageError
        && (
          error.code === "RELEASE_PACKAGE_CLEANUP"
          || error.code === "RELEASE_PACKAGE_CLEANUP_UNCERTAIN"
        )
      ),
    );
    assert.equal(existsSync(resolve(root, "dist/release")), false);
    assert.equal(
      readFileSync(resolve(root, "dist/extra"), "utf8"),
      "extra\n",
    );
  });
});

test("#33 CLI 参数、cwd 与错误输出均失败关闭且脱敏", () => {
  assert.throws(
    () => assertPackageSiteArguments(["unexpected"]),
    hasCode("RELEASE_PACKAGE_INPUT"),
  );
  assert.throws(
    () => assertCheckReleaseArguments(["unexpected"]),
    hasCode("RELEASE_PACKAGE_INPUT"),
  );
  let caught;
  createRepositoryFixture((root) => {
    try {
      runPackageSiteCli({root, cwd: tmpdir()});
    } catch (error) {
      caught = error;
    }
  });
  assert.ok(caught instanceof ReleasePackageError);
  assert.match(
    formatReleasePackageError(caught),
    /^\[RELEASE_PACKAGE_WORKSPACE\] /u,
  );
  assert.doesNotMatch(
    formatReleasePackageError(caught),
    /\/tmp\/|\/home\//u,
  );
});
