import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  checkNpmIsolation,
  findOperationalPackageManagerCommands,
  OPERATIONAL_NPM_BOUNDARY_PATHS,
} from "../../scripts/quality/check-npm-isolation.mjs";
import { buildQualityChildEnvironment } from "../../scripts/quality/lib/process-environment.mjs";
import { QUALITY_COMMANDS } from "../../scripts/quality/run-quality.mjs";
import { PROJECT_NPM_CONFIG } from "../../scripts/quality/lib/supply-chain/contracts.mjs";
import {
  parseProjectNpmrc,
  validateRuntimeContract,
  validateManifestObject,
} from "../../scripts/quality/lib/supply-chain/config.mjs";
import {
  assertEnvironmentIsClosed,
  createIsolationWorkspace,
  deriveNpmCli,
  parseAndValidateEffectiveConfig,
  removeIsolationWorkspace,
} from "../../scripts/quality/lib/supply-chain/environment.mjs";
import {
  formatIsolationError,
  NpmIsolationError,
} from "../../scripts/quality/lib/supply-chain/errors.mjs";
import { validateLockfileObject } from "../../scripts/quality/lib/supply-chain/lockfile.mjs";
import {
  buildProfileArguments,
  parseProfileArguments,
} from "../../scripts/quality/lib/supply-chain/profiles.mjs";
import {
  publishLockfile,
  runIsolatedNpm,
} from "../../scripts/quality/lib/supply-chain/runner.mjs";
import {
  findShellPackageManagerCommands,
  findWorkflowPackageManagerCommands,
} from "../../scripts/quality/lib/supply-chain/bypass.mjs";

const NODE_VERSION = process.versions.node;
const NODE_MAJOR = Number(NODE_VERSION.split(".")[0]);
const TEST_MINIMUM_NODE_VERSION = `${NODE_MAJOR}.0.0`;
const ACTUAL_NPM_VERSION = deriveNpmCli(process.execPath).npmVersion;
const TEST_NPM_VERSIONS = Object.freeze({
  primary: ACTUAL_NPM_VERSION,
  minimum: "0.0.0",
});

function expectedNpmrc() {
  return `${Object.entries(PROJECT_NPM_CONFIG).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

function baseManifest() {
  return {
    name: "e010-fixture",
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: {
      quality: "node scripts/quality/run-quality.mjs",
      typecheck: "tsc --noEmit",
      test: "node --test tests/build/run-isolated-npm.test.mjs",
      build: "node scripts/build/build-site.mjs --mode production",
      "check:artifact": "node scripts/quality/check-artifact.mjs",
    },
    engines: {
      node: `>=${TEST_MINIMUM_NODE_VERSION} <${NODE_MAJOR + 1}`,
    },
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createFakeNodeDistribution(outer) {
  const prefix = join(outer, "prefix");
  const npmRoot = join(prefix, "lib/node_modules/npm");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  mkdirSync(join(npmRoot, "bin"), { recursive: true });
  writeFileSync(join(prefix, "bin/node"), "fixture\n", "utf8");
  writeFileSync(join(npmRoot, "bin/npm-cli.js"), "fixture\n", "utf8");
  writeJson(join(npmRoot, "package.json"), {
    name: "npm",
    version: ACTUAL_NPM_VERSION,
    bin: { npm: "bin/npm-cli.js" },
  });
  chmodSync(npmRoot, 0o755);
  chmodSync(join(npmRoot, "bin"), 0o755);
  chmodSync(join(npmRoot, "bin/npm-cli.js"), 0o644);
  chmodSync(join(npmRoot, "package.json"), 0o644);
  return { prefix, npmRoot, node: join(prefix, "bin/node") };
}

function fakeNpmCliSource() {
  return `import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const npmRoot = dirname(fileURLToPath(import.meta.url));
const behavior = JSON.parse(readFileSync(join(npmRoot, "behavior.json"), "utf8"));
const args = process.argv.slice(2);
const env = process.env;
const mode = (path) => statSync(path).mode & 0o777;
const record = {
  args,
  cwd: process.cwd(),
  lockBefore: existsSync(join(process.cwd(), "package-lock.json"))
    ? readFileSync(join(process.cwd(), "package-lock.json"), "utf8")
    : null,
  envKeys: Object.keys(env).sort(),
  path: env.PATH,
  home: env.HOME,
  cache: env.NPM_CONFIG_CACHE,
  cacheEntriesBefore: readdirSync(env.NPM_CONFIG_CACHE).sort(),
  modes: {
    home: mode(env.HOME),
    cache: mode(env.NPM_CONFIG_CACHE),
    logs: mode(env.NPM_CONFIG_LOGS_DIR),
    tmp: mode(env.TMPDIR),
  },
  userconfigBytes: statSync(env.NPM_CONFIG_USERCONFIG).size,
  globalconfigBytes: statSync(env.NPM_CONFIG_GLOBALCONFIG).size,
};
appendFileSync(behavior.callsPath, JSON.stringify(record) + "\\n", "utf8");

if (args.join(" ") === "config list --json") {
  if (behavior.prewarmCache) {
    writeFileSync(join(env.NPM_CONFIG_CACHE, "unexpected-entry"), "fixture", "utf8");
  }
  if (behavior.invalidConfigJson) {
    process.stdout.write("not-json\\n");
    process.exit(0);
  }
  const config = {
    registry: env.NPM_CONFIG_REGISTRY,
    "replace-registry-host": env.NPM_CONFIG_REPLACE_REGISTRY_HOST,
    "strict-ssl": env.NPM_CONFIG_STRICT_SSL === "true",
    "ignore-scripts": env.NPM_CONFIG_IGNORE_SCRIPTS === "true",
    audit: env.NPM_CONFIG_AUDIT === "true",
    fund: env.NPM_CONFIG_FUND === "true",
    "update-notifier": env.NPM_CONFIG_UPDATE_NOTIFIER === "true",
    "package-lock": env.NPM_CONFIG_PACKAGE_LOCK === "true",
    "lockfile-version": Number(env.NPM_CONFIG_LOCKFILE_VERSION),
    cache: env.NPM_CONFIG_CACHE,
    userconfig: env.NPM_CONFIG_USERCONFIG,
    globalconfig: env.NPM_CONFIG_GLOBALCONFIG,
    "logs-dir": env.NPM_CONFIG_LOGS_DIR,
    ca: null,
    cafile: null,
    cert: null,
    key: null,
    proxy: null,
    "https-proxy": null,
    noproxy: [""],
    otp: null,
    ...(behavior.configOverride ?? {}),
  };
  if (behavior.preflightRootMutation) {
    writeFileSync(
      behavior.preflightRootMutation.path,
      behavior.preflightRootMutation.text,
      "utf8",
    );
  }
  process.stdout.write(JSON.stringify(config) + "\\n");
  process.exit(0);
}

if (behavior.mutateManifest) {
  const manifestPath = join(process.cwd(), "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.fixtureMutation = true;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\\n", "utf8");
}
if (behavior.writeManifest) {
  writeFileSync(
    join(process.cwd(), "package.json"),
    JSON.stringify(behavior.writeManifest, null, 2) + "\\n",
    "utf8",
  );
}
if (behavior.mutateNpmrc) {
  writeFileSync(join(process.cwd(), ".npmrc"), behavior.mutateNpmrc, "utf8");
}
if (behavior.writeCandidateLock) {
  writeFileSync(
    join(process.cwd(), "package-lock.json"),
    JSON.stringify(behavior.writeCandidateLock, null, 2) + "\\n",
    "utf8",
  );
}
if (behavior.rootLockMutation) {
  writeFileSync(behavior.rootLockMutation.path, behavior.rootLockMutation.text, "utf8");
}
process.stdout.write("fixture workload\\n");
process.exit(behavior.workloadExitCode ?? 0);
`;
}

function createFixture({ manifest = baseManifest(), behavior = {} } = {}) {
  const outer = mkdtempSync("/tmp/axial-muse-e010-test-");
  const root = join(outer, "project");
  const callsPath = join(outer, "calls.jsonl");
  const actualWorkloadPath = join(outer, "actual-workload.txt");
  const fakeCli = join(outer, "fake-npm-cli.mjs");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, "scripts/quality"), { recursive: true });
  writeFileSync(join(root, ".npmrc"), expectedNpmrc(), "utf8");
  writeFileSync(join(root, ".nvmrc"), `${NODE_VERSION}\n`, "utf8");
  writeJson(join(root, "package.json"), manifest);
  writeFileSync(
    join(root, "scripts/quality/run-quality.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(actualWorkloadPath)}, "ran\\n", "utf8");\n`,
    "utf8",
  );
  writeFileSync(fakeCli, fakeNpmCliSource(), "utf8");
  writeJson(join(outer, "behavior.json"), { callsPath, ...behavior });
  return {
    outer,
    root,
    fakeCli,
    callsPath,
    actualWorkloadPath,
    invocations: [],
  };
}

function runFixtureWithActualNpm(fixture) {
  const previousCwd = process.cwd();
  process.chdir(fixture.root);
  try {
    return runIsolatedNpm({
      root: fixture.root,
      profile: "run-script",
      scriptName: "quality",
      npmVersionsByRole: TEST_NPM_VERSIONS,
      temporaryParent: fixture.outer,
    });
  } finally {
    process.chdir(previousCwd);
  }
}

function destroyFixture(fixture) {
  rmSync(fixture.outer, { recursive: true, force: true });
}

function updateBehavior(fixture, change) {
  const path = join(fixture.outer, "behavior.json");
  const behavior = JSON.parse(readFileSync(path, "utf8"));
  writeJson(path, { ...behavior, ...change });
}

function writeControlledQualityPaths(fixture, {
  workflow = "jobs:\n  website-quality:\n    steps:\n      - run: node scripts/quality/run-quality.mjs\n",
  hook = "#!/bin/sh\nnode scripts/quality/run-quality.mjs\n",
} = {}) {
  mkdirSync(join(fixture.root, ".github/workflows"), { recursive: true });
  mkdirSync(join(fixture.root, ".githooks"), { recursive: true });
  writeFileSync(join(fixture.root, ".github/workflows/ci.yml"), workflow, "utf8");
  writeFileSync(join(fixture.root, ".githooks/pre-commit"), hook, "utf8");
  for (const path of OPERATIONAL_NPM_BOUNDARY_PATHS) {
    const target = join(fixture.root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "# fixture operational instructions\n", "utf8");
  }
}

function readCalls(fixture) {
  if (!existsSync(fixture.callsPath)) return [];
  return readFileSync(fixture.callsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runFixture(fixture, request = { profile: "run-script", scriptName: "quality" }) {
  const previousCwd = process.cwd();
  process.chdir(fixture.root);
  try {
    return runIsolatedNpm({
      root: fixture.root,
      ...request,
      runProcess(executable, arguments_, options) {
        fixture.invocations.push({ executable, arguments: [...arguments_] });
        return spawnSync(executable, [fixture.fakeCli, ...arguments_.slice(1)], options);
      },
      npmVersionsByRole: TEST_NPM_VERSIONS,
      temporaryParent: fixture.outer,
    });
  } finally {
    process.chdir(previousCwd);
  }
}

function expectCode(callback, expectedCode) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof NpmIsolationError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

function validEffectiveConfig(paths) {
  return {
    registry: PROJECT_NPM_CONFIG.registry,
    "replace-registry-host": "never",
    "strict-ssl": true,
    "ignore-scripts": true,
    audit: false,
    fund: false,
    "update-notifier": false,
    "package-lock": true,
    "lockfile-version": 3,
    cache: paths.cache,
    userconfig: paths.userconfig,
    globalconfig: paths.globalconfig,
    "logs-dir": paths.logs,
    ca: null,
    cafile: null,
    cert: null,
    key: null,
    proxy: null,
    "https-proxy": null,
    noproxy: [""],
  };
}

function validLockfile(manifest) {
  const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: manifest.name,
        version: manifest.version,
        dependencies: manifest.dependencies,
      },
      "node_modules/example-package": {
        version: "1.2.3",
        resolved: "https://registry.npmjs.org/example-package/-/example-package-1.2.3.tgz",
        integrity,
      },
    },
  };
}

test("E-010 npm isolation contract", async (t) => {
  await t.test("removes secrets and debug controls from quality child environments", () => {
    const syntheticSecret = "synthetic-e010-secret-value";
    const environment = buildQualityChildEnvironment({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/fixture-home",
      LANG: "C.UTF-8",
      CI: "true",
      NODE_DEBUG: "child_process",
      NODE_EXTRA_CA_CERTS: "/tmp/fixture-ca.pem",
      HTTPS_PROXY: "http://proxy.example.test",
      SYNTHETIC_SECRET: syntheticSecret,
    });
    assert.deepEqual(environment, {
      CI: "true",
      HOME: "/tmp/fixture-home",
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    });

    const helperUrl = new URL("../../scripts/quality/lib/process-environment.mjs", import.meta.url).href;
    const probe = `
      import { spawnSync } from "node:child_process";
      import { buildQualityChildEnvironment } from ${JSON.stringify(helperUrl)};
      const child = spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.SYNTHETIC_SECRET ?? 'absent')"], {
        encoding: "utf8",
        env: buildQualityChildEnvironment(process.env),
      });
      process.stdout.write(child.stdout);
      process.stderr.write(child.stderr);
      process.exit(child.status ?? 1);
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
      env: {
        HOME: "/tmp/fixture-home",
        LANG: "C.UTF-8",
        NODE_DEBUG: "child_process",
        PATH: process.env.PATH,
        SYNTHETIC_SECRET: syntheticSecret,
      },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "absent");
    assert.ok(!`${result.stdout}${result.stderr}`.includes(syntheticSecret));
  });

  await t.test("keeps the npm isolation checker and tests in every quality entry", () => {
    assert.deepEqual(QUALITY_COMMANDS, [
      ["scripts/quality/check-javascript.mjs"],
      ["scripts/quality/check-npm-isolation.mjs"],
      ["scripts/quality/check-markdown.mjs"],
      ["scripts/quality/check-contracts.mjs"],
      ["scripts/quality/check-secrets.mjs"],
      ["scripts/quality/check-static-site.mjs"],
      ["--test", "tests/build/run-isolated-npm.test.mjs"],
    ]);

    const valid = createFixture();
    try {
      writeControlledQualityPaths(valid);
      assert.equal(checkNpmIsolation(valid.root), undefined);
    } finally {
      destroyFixture(valid);
    }

    const missingRuntimeSource = createFixture();
    try {
      writeControlledQualityPaths(missingRuntimeSource);
      rmSync(join(missingRuntimeSource.root, ".nvmrc"));
      expectCode(() => checkNpmIsolation(missingRuntimeSource.root), "NPM_RUNTIME_NVMRC");
    } finally {
      destroyFixture(missingRuntimeSource);
    }

    for (const path of [
      ".node-version",
      ".tool-versions",
      ".mise.local.toml",
      ".mise.production.toml",
      ".mise.toml",
      ".rtx.local.toml",
      ".rtx.production.toml",
      ".rtx.toml",
      ".mise.lock",
      "mise.lock",
      "mise.ci.toml",
      "mise.local.toml",
      "mise.toml",
      "rtx.local.toml",
      "rtx.toml",
    ]) {
      const competingRuntimeSource = createFixture();
      try {
        writeControlledQualityPaths(competingRuntimeSource);
        writeFileSync(join(competingRuntimeSource.root, path), "0.0.1\n", "utf8");
        expectCode(
          () => checkNpmIsolation(competingRuntimeSource.root),
          "NPM_RUNTIME_COMPETING",
        );
      } finally {
        destroyFixture(competingRuntimeSource);
      }
    }

    const disconnected = createFixture();
    try {
      writeControlledQualityPaths(disconnected, {
        workflow: "jobs:\n  website-quality:\n    steps:\n      - run: node scripts/quality/check-markdown.mjs\n",
      });
      assert.throws(() => checkNpmIsolation(disconnected.root), /CI 与 pre-commit/);
    } finally {
      destroyFixture(disconnected);
    }

    const compensated = createFixture();
    try {
      writeControlledQualityPaths(compensated, {
        workflow: "jobs:\n  website-quality:\n    steps:\n      - run: node scripts/quality/check-markdown.mjs\n  diagrams:\n    steps:\n      - run: node scripts/quality/run-quality.mjs\n",
      });
      writeFileSync(
        join(compensated.root, ".github/workflows/decoy.yml"),
        "jobs:\n  decoy:\n    steps:\n      - run: node scripts/quality/run-quality.mjs\n",
        "utf8",
      );
      assert.throws(() => checkNpmIsolation(compensated.root), /CI 与 pre-commit/);
    } finally {
      destroyFixture(compensated);
    }

    const detachedJob = createFixture();
    try {
      writeControlledQualityPaths(detachedJob, {
        workflow: "website-quality:\n  steps:\n    - run: node scripts/quality/run-quality.mjs\njobs:\n  diagrams:\n    steps:\n      - run: node scripts/quality/check-diagrams.mjs\n",
      });
      assert.throws(() => checkNpmIsolation(detachedJob.root), /CI 与 pre-commit/);
    } finally {
      destroyFixture(detachedJob);
    }

    for (const workflow of [
      "jobs:\n  website-quality:\n    env:\n      run: node scripts/quality/run-quality.mjs\n    steps:\n      - run: echo noop\n",
      "jobs:\n  website-quality:\n    steps:\n      - if: ${{ false }}\n        run: node scripts/quality/run-quality.mjs\n",
      "jobs:\n  website-quality:\n    steps:\n      - continue-on-error: true\n        run: node scripts/quality/run-quality.mjs\n      - run: echo noop\n",
      "jobs:\n  website-quality:\n    steps:\n      - \"if\": ${{ false }}\n        \"run\": node scripts/quality/run-quality.mjs\n",
      "jobs:\n  website-quality:\n    steps:\n      - name: setup\n      - <<: *skipped\n        run: node scripts/quality/run-quality.mjs\n",
      "jobs:\n  gate:\n    if: ${{ false }}\n    steps:\n      - run: echo skipped\n  website-quality:\n    needs: gate\n    steps:\n      - run: node scripts/quality/run-quality.mjs\n",
      "env:\n  NODE_OPTIONS: --import=./fixture.mjs\njobs:\n  website-quality:\n    steps:\n      - run: node scripts/quality/run-quality.mjs\n",
    ]) {
      const nonExecuting = createFixture();
      try {
        writeControlledQualityPaths(nonExecuting, { workflow });
        assert.throws(() => checkNpmIsolation(nonExecuting.root), /CI 与 pre-commit/);
      } finally {
        destroyFixture(nonExecuting);
      }
    }
  });

  await t.test("accepts only the exact nine-key project npmrc", () => {
    assert.deepEqual(parseProjectNpmrc(expectedNpmrc()), PROJECT_NPM_CONFIG);
    const cases = [
      [expectedNpmrc().replace("lockfile-version=3\n", ""), "NPM_CONFIG_MISSING"],
      [`${expectedNpmrc()}registry=https://registry.npmjs.org/\n`, "NPM_CONFIG_DUPLICATE"],
      [`${expectedNpmrc()}cache=/tmp/cache\n`, "NPM_CONFIG_UNKNOWN"],
      [`${expectedNpmrc()}@evil:registry=https://example.test/\n`, "NPM_CONFIG_FORBIDDEN"],
      [expectedNpmrc().replace("audit=false", "audit=${NPM_AUDIT}"), "NPM_CONFIG_FORBIDDEN"],
      [expectedNpmrc().replace(PROJECT_NPM_CONFIG.registry, "https://registry.npmmirror.com/"), "NPM_CONFIG_VALUE"],
      [expectedNpmrc().replace("fund=false", " fund=false"), "NPM_CONFIG_SYNTAX"],
    ];
    for (const [text, code] of cases) expectCode(() => parseProjectNpmrc(text), code);

    const marker = "synthetic-secret-key-marker";
    let diagnostic;
    try {
      parseProjectNpmrc(`${expectedNpmrc()}${marker}=fixture\n`);
    } catch (error) {
      diagnostic = formatIsolationError(error);
    }
    assert.ok(!diagnostic.includes(marker));
  });

  await t.test("rejects every non-registry manifest source before npm starts", () => {
    const badSpecs = [
      "latest",
      "*",
      "npm:other@1.0.0",
      "git+https://example.test/repo.git",
      "file:../package",
      "workspace:*",
      "../package",
      "https://example.test/package.tgz",
    ];
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const spec of badSpecs) {
        const manifest = baseManifest();
        manifest[section] = { "example-package": spec };
        expectCode(() => validateManifestObject(manifest), "NPM_MANIFEST_SOURCE");
      }
    }
    const manifest = baseManifest();
    manifest.overrides = { "example-package": "1.0.0" };
    expectCode(() => validateManifestObject(manifest), "NPM_MANIFEST_SOURCE_FIELD");
    for (const [field, value] of [
      ["packageManager", "pnpm@9.0.0"],
      ["devEngines", { packageManager: { name: "pnpm" } }],
    ]) {
      const secondSource = baseManifest();
      secondSource[field] = value;
      expectCode(() => validateManifestObject(secondSource), "NPM_MANIFEST_SOURCE_FIELD");
    }
    const npmEngine = baseManifest();
    npmEngine.engines.npm = "11.16.0";
    expectCode(() => validateManifestObject(npmEngine), "NPM_MANIFEST_SOURCE_FIELD");
    const voltaManifest = baseManifest();
    voltaManifest.volta = { node: NODE_VERSION };
    expectCode(() => validateManifestObject(voltaManifest), "NPM_RUNTIME_COMPETING");
    const nullEngines = baseManifest();
    nullEngines.engines = null;
    expectCode(() => validateManifestObject(nullEngines), "NPM_MANIFEST_ENGINES");
    for (const command of ["npm run check", "/usr/bin/npm run check", "\"npm\" run check"]) {
      const bypass = baseManifest();
      bypass.scripts.quality = command;
      expectCode(() => validateManifestObject(bypass), "NPM_MANIFEST_SCRIPT_BYPASS");
    }
    for (const command of ["nice npm ci", "timeout 60 npm ci", "sudo npm ci", "find . -exec npm ci ;"]) {
      const bypass = baseManifest();
      bypass.scripts.quality = command;
      expectCode(() => validateManifestObject(bypass), "NPM_MANIFEST_SCRIPT_BYPASS");
    }
    const wrongQualityEntry = baseManifest();
    wrongQualityEntry.scripts.quality = "node scripts/quality/other.mjs";
    expectCode(() => validateManifestObject(wrongQualityEntry), "NPM_MANIFEST_SCRIPT_COMMAND");
  });

  await t.test("validates lock v3 registry origin, integrity and manifest binding", () => {
    const manifest = baseManifest();
    manifest.dependencies = { "example-package": "^1.0.0" };
    const lockfile = validLockfile(manifest);
    assert.equal(validateLockfileObject(structuredClone(lockfile), manifest).lockfileVersion, 3);

    const scopedManifest = baseManifest();
    scopedManifest.dependencies = { "@docusaurus/core": "^3.10.2" };
    const scopedLock = validLockfile(scopedManifest);
    delete scopedLock.packages["node_modules/example-package"];
    const integrity = `sha512-${Buffer.alloc(64, 2).toString("base64")}`;
    scopedLock.packages["node_modules/@docusaurus/core"] = {
      version: "3.10.2",
      resolved: "https://registry.npmjs.org/@docusaurus/core/-/core-3.10.2.tgz",
      integrity,
      dependencies: { semver: "^7.7.1" },
    };
    scopedLock.packages["node_modules/@docusaurus/core/node_modules/semver"] = {
      version: "7.7.2",
      resolved: "https://registry.npmjs.org/semver/-/semver-7.7.2.tgz",
      integrity,
    };
    assert.equal(validateLockfileObject(scopedLock, scopedManifest).lockfileVersion, 3);

    const mutations = [
      [(value) => { value.lockfileVersion = 2; }, "NPM_LOCK_VERSION"],
      [(value) => { value.packages["node_modules/example-package"].resolved = "https://registry.npmmirror.com/example-package.tgz"; }, "NPM_LOCK_REGISTRY"],
      [(value) => { value.packages["node_modules/example-package"].resolved += "?token=fixture"; }, "NPM_LOCK_REGISTRY"],
      [(value) => { value.packages["node_modules/example-package"].resolved = "https://user@example.test/package.tgz"; }, "NPM_LOCK_REGISTRY"],
      [(value) => { delete value.packages["node_modules/example-package"].integrity; }, "NPM_LOCK_INTEGRITY"],
      [(value) => { value.packages["node_modules/example-package"].integrity = "sha256-invalid"; }, "NPM_LOCK_INTEGRITY"],
      [(value) => { value.packages["node_modules/example-package"].version = "file:../package"; }, "NPM_LOCK_PACKAGE_VERSION"],
      [(value) => { value.packages["node_modules/example-package"].link = true; }, "NPM_LOCK_PACKAGE_ENTRY"],
      [(value) => {
        value.packages["node_modules/../evil"] = value.packages["node_modules/example-package"];
        delete value.packages["node_modules/example-package"];
      }, "NPM_LOCK_PACKAGE_PATH"],
      [(value) => { value.packages["node_modules/example-package"].resolved = "https://registry.npmjs.org/other/-/other-1.2.3.tgz"; }, "NPM_LOCK_TARBALL_IDENTITY"],
      [(value) => { value.name = "wrong-root"; }, "NPM_LOCK_ROOT_IDENTITY"],
      [(value) => { value.packages["node_modules/example-package"].dependencies = { bad: "git+https://example.test/repo.git" }; }, "NPM_LOCK_DEPENDENCY_SOURCE"],
      [(value) => { value.packages["node_modules/example-package"].dependencies = { bad: "payload.tgz" }; }, "NPM_LOCK_DEPENDENCY_SOURCE"],
      [(value) => { value.packages[""].dependencies["example-package"] = "^2.0.0"; }, "NPM_LOCK_MANIFEST_DRIFT"],
    ];
    for (const [mutate, code] of mutations) {
      const candidate = structuredClone(lockfile);
      mutate(candidate);
      expectCode(() => validateLockfileObject(candidate, manifest), code);
    }
  });

  await t.test("allows inert npm defaults but rejects scoped, credential, proxy and CA config", () => {
    const paths = {
      cache: "/tmp/e010/cache",
      userconfig: "/tmp/e010/user.npmrc",
      globalconfig: "/tmp/e010/global.npmrc",
      logs: "/tmp/e010/logs",
    };
    const valid = validEffectiveConfig(paths);
    assert.equal(parseAndValidateEffectiveConfig(JSON.stringify(valid), paths).registry, PROJECT_NPM_CONFIG.registry);

    const mutations = [
      [{ "@evil:registry": "https://example.test/" }, "NPM_EFFECTIVE_SCOPED_REGISTRY"],
      [{ "//registry.npmjs.org/:_authToken": "(protected)" }, "NPM_EFFECTIVE_CREDENTIAL"],
      [{ _auth: "(protected)" }, "NPM_EFFECTIVE_CREDENTIAL"],
      [{ otp: "123456" }, "NPM_EFFECTIVE_CREDENTIAL"],
      [{ proxy: "http://proxy.example.test" }, "NPM_EFFECTIVE_SENSITIVE"],
      [{ cafile: "/tmp/fixture-ca.pem" }, "NPM_EFFECTIVE_SENSITIVE"],
      [{ "//registry.npmjs.org/:cafile": "/tmp/fixture-ca.pem" }, "NPM_EFFECTIVE_SENSITIVE"],
      [{ "//registry.npmjs.org/:certfile": "/tmp/fixture-cert.pem" }, "NPM_EFFECTIVE_SENSITIVE"],
      [{ "//registry.npmjs.org/:keyfile": "/tmp/fixture-key.pem" }, "NPM_EFFECTIVE_SENSITIVE"],
      [{ registry: "https://registry.npmmirror.com/" }, "NPM_EFFECTIVE_CONFIG_VALUE"],
    ];
    for (const [change, code] of mutations) {
      expectCode(
        () => parseAndValidateEffectiveConfig(JSON.stringify({ ...valid, ...change }), paths),
        code,
      );
    }
    const marker = "synthetic-secret-host-marker";
    try {
      parseAndValidateEffectiveConfig(JSON.stringify({
        ...valid,
        [`//${marker}.example/:_authToken`]: marker,
      }), paths);
      assert.fail("credential mutation must fail");
    } catch (error) {
      assert.ok(!formatIsolationError(error).includes(marker));
    }
  });

  await t.test("maps all five profiles to closed command lines", () => {
    const manifest = baseManifest();
    const cases = [
      ["resolve-lock", null, ["install", "--package-lock-only", "--ignore-scripts", "--audit=false", "--fund=false", "--allow-git=none", "--allow-file=none", "--allow-directory=none", "--allow-remote=none"]],
      ["ci", null, ["ci", "--ignore-scripts", "--audit=false", "--fund=false"]],
      ["audit", null, ["audit", "--include=dev", "--audit-level=moderate", "--json"]],
      ["sbom-native", null, ["sbom", "--package-lock-only", "--sbom-format=spdx", "--sbom-type=application", "--offline"]],
      ["run-script", "quality", ["run", "quality"]],
    ];
    for (const [profile, scriptName, expected] of cases) {
      assert.deepEqual(
        buildProfileArguments({ profile, scriptName, runtimeRole: "primary", manifest }),
        expected,
      );
    }
    expectCode(() => parseProfileArguments([]), "NPM_PROFILE_REQUIRED");
    expectCode(() => parseProfileArguments(["install"]), "NPM_PROFILE_UNKNOWN");
    expectCode(() => parseProfileArguments(["ci", "--registry=https://example.test"]), "NPM_PROFILE_ARGUMENTS");
    expectCode(() => parseProfileArguments(["run-script", "publish"]), "NPM_PROFILE_SCRIPT");
    expectCode(
      () => buildProfileArguments({ profile: "resolve-lock", runtimeRole: "minimum", manifest }),
      "NPM_PROFILE_PRIMARY_ONLY",
    );
    expectCode(
      () => buildProfileArguments({ profile: "run-script", scriptName: "publish", runtimeRole: "primary", manifest: { scripts: { publish: "node publish.mjs" } } }),
      "NPM_PROFILE_SCRIPT",
    );
  });

  await t.test("detects direct package-manager bypasses in scripts and workflow run blocks", () => {
    for (const command of [
      "npm run quality",
      "/usr/bin/npm run quality",
      "/usr/bin/n[p]m run quality",
      "/usr/bin/n?m run quality",
      "/usr/bin/n{p,x}m run quality",
      "\"npm\" run quality",
      "\\npm run quality",
      "n\\pm run quality",
      "command n\"\"pm run quality",
      "PM=npm; \"$PM\" run quality",
      "exec npm ci",
      "env -u HOME npm ci",
      "node /usr/lib/node_modules/npm/bin/npm-cli.js ci",
      "nice npm ci",
      "time npm ci",
      "if npm ci; then :; fi",
      "find . -exec npm ci ;",
      "$(printf npm) ci",
      "shopt -s expand_aliases; alias pm=npm; pm ci",
      "builtin alias pm='npm ci'; pm",
      "npx tool",
      "corepack yarn test",
    ]) {
      assert.equal(findShellPackageManagerCommands(`#!/bin/sh\n${command}\n`).length, 1);
      assert.equal(findWorkflowPackageManagerCommands(`steps:\n  - run: ${command}\n`).length, 1);
    }
    assert.deepEqual(findShellPackageManagerCommands("node scripts/quality/run-quality.mjs\n"), []);
    assert.deepEqual(findShellPackageManagerCommands("echo \"npm ci is forbidden\"\n"), []);
    assert.equal(
      findOperationalPackageManagerCommands("提交前运行 `npm run quality`。\n").length,
      1,
    );
    assert.deepEqual(
      findOperationalPackageManagerCommands(
        "提交前运行 `node scripts/quality/run-isolated-npm.mjs run-script quality`。\n",
      ),
      [],
    );
    assert.deepEqual(
      findOperationalPackageManagerCommands(
        "字段匹配 `^[a-z0-9]+$`，拒绝 `export *` 和 `build/assets/projects/**`。\n",
      ),
      [],
    );
    assert.equal(
      findOperationalPackageManagerCommands("```bash\nnpm run quality\n```\n").length,
      1,
    );
    assert.equal(
      findOperationalPackageManagerCommands(
        "```bash title=\"Quality\"\nnpm run quality\n```\n",
      ).length,
      1,
    );
    assert.equal(
      findOperationalPackageManagerCommands("提交前运行 npm run quality。\n").length,
      1,
    );
    assert.equal(
      findOperationalPackageManagerCommands("安装前运行 npm i。\n").length,
      1,
    );
    assert.equal(
      findOperationalPackageManagerCommands(
        "依次运行 npm --offline run quality。\n",
      ).length,
      1,
    );
    assert.deepEqual(
      findOperationalPackageManagerCommands("包管理器是 `npm`。\n"),
      [],
    );
    assert.deepEqual(
      findOperationalPackageManagerCommands(
        "```sh\nnode scripts/quality/run-isolated-npm.mjs run-script quality\n```\n",
      ),
      [],
    );
    assert.deepEqual(
      findOperationalPackageManagerCommands("```text\nnpm run quality\n```\n"),
      [],
    );
    assert.equal(
      findOperationalPackageManagerCommands(
        "```shell-session\n$ npm run quality\n```\n",
      ).length,
      1,
    );
    assert.ok(!OPERATIONAL_NPM_BOUNDARY_PATHS.includes("docs/projects/docrestore-experience.md"));
    assert.ok(!OPERATIONAL_NPM_BOUNDARY_PATHS.includes("docs/projects/vibecoding-project-scaffold.md"));
    assert.equal(findShellPackageManagerCommands("PM=npm\n\"$PM\" ci\n").length, 1);
    assert.deepEqual(
      findWorkflowPackageManagerCommands("steps:\n  - run: |\n      node scripts/quality/run-quality.mjs\n"),
      [],
    );
    assert.deepEqual(findWorkflowPackageManagerCommands("# run: npm ci\n"), []);
    assert.deepEqual(findWorkflowPackageManagerCommands("name: \"do not run: npm ci\"\n"), []);
    for (const header of ["|+", ">+", "|2-", ">-2"]) {
      assert.equal(
        findWorkflowPackageManagerCommands(`steps:\n  - run: ${header}\n      npm ci\n`).length,
        1,
      );
    }
    for (const workflow of [
      "steps:\n  - { run: npm ci }\n",
      "steps:\n  - run : npm ci\n",
      "steps:\n  - \"run\": npm ci\n",
      "steps:\n  - run: \"npm ci\"\n",
      "steps:\n  - run:\n      npm ci\n",
      "steps: [{run: npm ci}]\n",
      "steps:\n  - run: >\n      env -u\n      HOME npm ci\n",
      "steps:\n  - run: env\n      npm ci\n",
      "steps:\n  - run: env\n\n        npm ci\n",
      "steps:\n  - run: |\n      PM=npm\n      \"$PM\" ci\n",
      "steps:\n  - run: *package_manager_command\n",
      "steps:\n  - run: ${{ matrix.command }}\n",
      "steps:\n  - \"r\\u0075n\": npm ci\n",
    ]) {
      assert.equal(findWorkflowPackageManagerCommands(workflow).length, 1);
    }
  });

  await t.test("derives npm from the current Node prefix rather than PATH", () => {
    const previousPath = process.env.PATH;
    const hostile = mkdtempSync("/tmp/axial-muse-hostile-path-");
    try {
      writeFileSync(join(hostile, "npm"), "must-not-run\n", "utf8");
      process.env.PATH = hostile;
      const runtime = deriveNpmCli(process.execPath);
      assert.equal(runtime.nodeExecutable, realpathSync(process.execPath));
      assert.ok(runtime.npmCli.endsWith("/lib/node_modules/npm/bin/npm-cli.js"));
      assert.notEqual(dirname(runtime.npmCli), hostile);
    } finally {
      process.env.PATH = previousPath;
      rmSync(hostile, { recursive: true, force: true });
    }
  });

  await t.test("rejects npm directory symlink escape from a Node prefix", () => {
    const outer = mkdtempSync("/tmp/axial-muse-cli-escape-");
    const prefix = join(outer, "prefix");
    const externalNpm = join(outer, "external-npm");
    try {
      mkdirSync(join(prefix, "bin"), { recursive: true });
      mkdirSync(join(prefix, "lib/node_modules"), { recursive: true });
      mkdirSync(join(externalNpm, "bin"), { recursive: true });
      writeFileSync(join(prefix, "bin/node"), "fixture\n", "utf8");
      writeFileSync(join(externalNpm, "bin/npm-cli.js"), "fixture\n", "utf8");
      writeJson(join(externalNpm, "package.json"), {
        name: "npm",
        version: ACTUAL_NPM_VERSION,
        bin: { npm: "bin/npm-cli.js" },
      });
      symlinkSync(externalNpm, join(prefix, "lib/node_modules/npm"), "dir");
      expectCode(() => deriveNpmCli(join(prefix, "bin/node")), "NPM_CLI_FILE_TYPE");
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  await t.test("rejects hard-linked or broadly writable npm CLI files", () => {
    const outer = mkdtempSync("/tmp/axial-muse-cli-trust-");
    const prefix = join(outer, "prefix");
    const npmRoot = join(prefix, "lib/node_modules/npm");
    try {
      mkdirSync(join(prefix, "bin"), { recursive: true });
      mkdirSync(join(npmRoot, "bin"), { recursive: true });
      writeFileSync(join(prefix, "bin/node"), "fixture\n", "utf8");
      writeFileSync(join(outer, "external-cli.js"), "fixture\n", "utf8");
      linkSync(join(outer, "external-cli.js"), join(npmRoot, "bin/npm-cli.js"));
      writeJson(join(npmRoot, "package.json"), {
        name: "npm",
        version: ACTUAL_NPM_VERSION,
        bin: { npm: "bin/npm-cli.js" },
      });
      expectCode(() => deriveNpmCli(join(prefix, "bin/node")), "NPM_CLI_FILE_TRUST");
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }

    const writableOuter = mkdtempSync("/tmp/axial-muse-cli-writable-");
    try {
      const distribution = createFakeNodeDistribution(writableOuter);
      chmodSync(join(distribution.npmRoot, "bin/npm-cli.js"), 0o777);
      expectCode(() => deriveNpmCli(distribution.node), "NPM_CLI_FILE_TRUST");
    } finally {
      rmSync(writableOuter, { recursive: true, force: true });
    }
  });

  await t.test("rejects npm CLI metadata identity and version drift", () => {
    const outer = mkdtempSync("/tmp/axial-muse-cli-metadata-");
    try {
      const distribution = createFakeNodeDistribution(outer);
      writeJson(join(distribution.npmRoot, "package.json"), {
        name: "not-npm",
        version: ACTUAL_NPM_VERSION,
        bin: { npm: "bin/npm-cli.js" },
      });
      expectCode(() => deriveNpmCli(distribution.node), "NPM_CLI_IDENTITY");

      writeJson(join(distribution.npmRoot, "package.json"), {
        name: "npm",
        version: 11,
        bin: { npm: "bin/npm-cli.js" },
      });
      expectCode(() => deriveNpmCli(distribution.node), "NPM_CLI_VERSION");
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  await t.test("rejects links and untrusted files anywhere in the npm CLI loading tree", () => {
    const outer = mkdtempSync("/tmp/axial-muse-cli-tree-");
    try {
      const distribution = createFakeNodeDistribution(outer);
      const outsideLib = join(outer, "outside-lib");
      mkdirSync(outsideLib, { recursive: true });
      symlinkSync(outsideLib, join(distribution.npmRoot, "lib"), "dir");
      expectCode(() => deriveNpmCli(distribution.node), "NPM_CLI_TREE_TRUST");
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }

    const writableOuter = mkdtempSync("/tmp/axial-muse-cli-tree-writable-");
    try {
      const distribution = createFakeNodeDistribution(writableOuter);
      mkdirSync(join(distribution.npmRoot, "lib"));
      writeFileSync(join(distribution.npmRoot, "lib/nested.js"), "fixture\n", "utf8");
      chmodSync(join(distribution.npmRoot, "lib/nested.js"), 0o666);
      expectCode(() => deriveNpmCli(distribution.node), "NPM_CLI_TREE_TRUST");
    } finally {
      rmSync(writableOuter, { recursive: true, force: true });
    }

    const hardlinkOuter = mkdtempSync("/tmp/axial-muse-cli-tree-hardlink-");
    try {
      const distribution = createFakeNodeDistribution(hardlinkOuter);
      mkdirSync(join(distribution.npmRoot, "lib"));
      writeFileSync(join(hardlinkOuter, "external-nested.js"), "fixture\n", "utf8");
      linkSync(
        join(hardlinkOuter, "external-nested.js"),
        join(distribution.npmRoot, "lib/nested.js"),
      );
      expectCode(() => deriveNpmCli(distribution.node), "NPM_CLI_TREE_TRUST");
    } finally {
      rmSync(hardlinkOuter, { recursive: true, force: true });
    }
  });

  await t.test("requires an exact environment-key allowlist", () => {
    const fixture = createFixture();
    let workspace;
    try {
      workspace = createIsolationWorkspace({
        root: fixture.root,
        nodeExecutable: process.execPath,
        temporaryParent: fixture.outer,
      });
      const context = {
        paths: workspace.paths,
        root: fixture.root,
        nodeExecutable: process.execPath,
      };
      assert.equal(assertEnvironmentIsClosed(workspace.environment, context), workspace.environment);
      expectCode(
        () => assertEnvironmentIsClosed({ ...workspace.environment, GITHUB_PAT: "synthetic-fixture" }, context),
        "NPM_ENVIRONMENT_ALLOWLIST",
      );
      for (const [key, value] of [
        ["PATH", "/tmp/hostile"],
        ["HOME", "/home/fixture-user"],
        ["TMPDIR", "/tmp/shared"],
        ["LANG", "en_US.UTF-8"],
      ]) {
        expectCode(
          () => assertEnvironmentIsClosed({ ...workspace.environment, [key]: value }, context),
          "NPM_ENVIRONMENT_VALUE",
        );
      }
    } finally {
      if (workspace) removeIsolationWorkspace(workspace.paths.root);
      destroyFixture(fixture);
    }
  });

  await t.test("removes a partially created isolation workspace", () => {
    const parent = mkdtempSync("/tmp/axial-muse-workspace-cleanup-");
    try {
      const before = readdirSync(parent);
      expectCode(() => createIsolationWorkspace({
        root: parent,
        nodeExecutable: join(parent, "missing-node"),
        temporaryParent: parent,
      }), "NPM_ENV_NODE_PATH");
      assert.deepEqual(readdirSync(parent), before);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  await t.test("binds nvmrc, engines and endpoint roles as one exact runtime contract", () => {
    const fixture = createFixture();
    const manifest = baseManifest();
    try {
      assert.equal(validateRuntimeContract({
        root: fixture.root,
        nodeVersion: NODE_VERSION,
        npmVersion: ACTUAL_NPM_VERSION,
        manifest,
        npmVersionsByRole: TEST_NPM_VERSIONS,
      }).role, "primary");
      assert.equal(validateRuntimeContract({
        root: fixture.root,
        nodeVersion: TEST_MINIMUM_NODE_VERSION,
        npmVersion: "0.0.0",
        manifest,
        npmVersionsByRole: TEST_NPM_VERSIONS,
      }).role, "minimum");

      writeFileSync(join(fixture.root, ".nvmrc"), `${NODE_VERSION}\n\n`, "utf8");
      expectCode(() => validateRuntimeContract({
        root: fixture.root,
        nodeVersion: NODE_VERSION,
        npmVersion: ACTUAL_NPM_VERSION,
        manifest,
        npmVersionsByRole: TEST_NPM_VERSIONS,
      }), "NPM_RUNTIME_NVMRC");

      writeFileSync(join(fixture.root, ".nvmrc"), `${NODE_VERSION}\n`, "utf8");
      expectCode(() => validateRuntimeContract({
        root: fixture.root,
        nodeVersion: NODE_VERSION,
        npmVersion: ACTUAL_NPM_VERSION,
        manifest,
        npmVersionsByRole: {
          ...TEST_NPM_VERSIONS,
          rogue: "1.0.0",
        },
      }), "NPM_RUNTIME_ENDPOINT_SET");

      expectCode(() => validateRuntimeContract({
        root: fixture.root,
        nodeVersion: NODE_VERSION,
        npmVersion: ACTUAL_NPM_VERSION,
        manifest,
        npmVersionsByRole: {
          primary: ACTUAL_NPM_VERSION,
          minimum: "not-semver",
        },
      }), "NPM_RUNTIME_ENDPOINT_SCHEMA");

      const invertedManifest = baseManifest();
      invertedManifest.engines.node = `>=${NODE_MAJOR}.16.0 <${NODE_MAJOR + 1}`;
      writeFileSync(join(fixture.root, ".nvmrc"), `${NODE_MAJOR}.1.0\n`, "utf8");
      expectCode(() => validateRuntimeContract({
        root: fixture.root,
        nodeVersion: `${NODE_MAJOR}.1.0`,
        npmVersion: ACTUAL_NPM_VERSION,
        manifest: invertedManifest,
        npmVersionsByRole: TEST_NPM_VERSIONS,
      }), "NPM_RUNTIME_CONTRACT");

      const upgradedPrimary = `${NODE_MAJOR}.99.1`;
      writeFileSync(join(fixture.root, ".nvmrc"), `${upgradedPrimary}\n`, "utf8");
      assert.equal(validateRuntimeContract({
        root: fixture.root,
        nodeVersion: upgradedPrimary,
        npmVersion: "9.9.9",
        manifest,
        npmVersionsByRole: {
          primary: "9.9.9",
          minimum: "0.0.0",
        },
      }).role, "primary");
    } finally {
      destroyFixture(fixture);
    }
  });

  await t.test("runs a legal workload only after isolated config preflight", () => {
    const fixture = createFixture();
    const inherited = {
      PATH: process.env.PATH,
      npmConfig: process.env.nPm_CoNfIg_ReGiStRy,
      proxy: process.env.HtTp_PrOxY,
      ca: process.env.NODE_EXTRA_CA_CERTS,
    };
    try {
      process.env.PATH = "/tmp/hostile-path";
      process.env.nPm_CoNfIg_ReGiStRy = "https://registry.npmmirror.com/";
      process.env.HtTp_PrOxY = "http://proxy.example.test";
      process.env.NODE_EXTRA_CA_CERTS = "/tmp/fixture-ca.pem";
      const result = runFixture(fixture);
      assert.equal(result.profile, "run-script");
      assert.deepEqual(result.arguments, ["run", "quality"]);

      const calls = readCalls(fixture);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0].args, ["config", "list", "--json"]);
      assert.deepEqual(calls[1].args, ["run", "quality"]);
      assert.equal(fixture.invocations.length, 2);
      assert.equal(fixture.invocations[0].executable, realpathSync(process.execPath));
      assert.equal(fixture.invocations[0].arguments[0], deriveNpmCli(process.execPath).npmCli);
      assert.equal(calls[0].userconfigBytes, 0);
      assert.equal(calls[0].globalconfigBytes, 0);
      assert.deepEqual(calls[0].cacheEntriesBefore, []);
      assert.deepEqual(calls[0].modes, { home: 0o700, cache: 0o700, logs: 0o700, tmp: 0o700 });
      assert.ok(!calls[0].path.includes("hostile-path"));
      const childKeys = calls[0].envKeys.map((key) => key.toLowerCase());
      for (const key of ["node_extra_ca_certs", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "node_env"]) {
        assert.ok(!childKeys.includes(key));
      }
      assert.ok(!existsSync(calls[0].home));
    } finally {
      process.env.PATH = inherited.PATH;
      if (inherited.npmConfig === undefined) delete process.env.nPm_CoNfIg_ReGiStRy;
      else process.env.nPm_CoNfIg_ReGiStRy = inherited.npmConfig;
      if (inherited.proxy === undefined) delete process.env.HtTp_PrOxY;
      else process.env.HtTp_PrOxY = inherited.proxy;
      if (inherited.ca === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = inherited.ca;
      destroyFixture(fixture);
    }
  });

  await t.test("interoperates with the bundled npm offline config output", () => {
    const fixture = createFixture();
    try {
      const result = runFixtureWithActualNpm(fixture);
      assert.equal(result.profile, "run-script");
      assert.equal(readFileSync(fixture.actualWorkloadPath, "utf8"), "ran\n");
    } finally {
      destroyFixture(fixture);
    }
  });

  await t.test("runs ci, audit and sbom through the complete isolated runner", () => {
    const manifest = baseManifest();
    manifest.dependencies = { "example-package": "^1.0.0" };
    const lockfile = validLockfile(manifest);
    const cases = [
      ["ci", ["ci", "--ignore-scripts", "--audit=false", "--fund=false"]],
      ["audit", ["audit", "--include=dev", "--audit-level=moderate", "--json"]],
      ["sbom-native", ["sbom", "--package-lock-only", "--sbom-format=spdx", "--sbom-type=application", "--offline"]],
    ];
    for (const [profile, expectedArguments] of cases) {
      const missingLock = createFixture({ manifest });
      try {
        expectCode(() => runFixture(missingLock, { profile, scriptName: null }), "NPM_LOCK_FILE");
        assert.deepEqual(readCalls(missingLock), []);
      } finally {
        destroyFixture(missingLock);
      }

      const fixture = createFixture({ manifest });
      try {
        writeJson(join(fixture.root, "package-lock.json"), lockfile);
        const result = runFixture(fixture, { profile, scriptName: null });
        assert.deepEqual(result.arguments, expectedArguments);
        const calls = readCalls(fixture);
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[0].args, ["config", "list", "--json"]);
        assert.deepEqual(calls[1].args, expectedArguments);
        assert.equal(calls[1].cwd, fixture.root);
        assert.equal(calls[1].lockBefore, `${JSON.stringify(lockfile, null, 2)}\n`);
        assert.ok(!existsSync(calls[0].home));
      } finally {
        destroyFixture(fixture);
      }
    }
  });

  await t.test("rejects local bin escapes before a run-script workload", () => {
    const escaped = createFixture();
    try {
      const outside = join(escaped.outer, "outside-node-modules");
      mkdirSync(join(outside, ".bin"), { recursive: true });
      symlinkSync(outside, join(escaped.root, "node_modules"), "dir");
      expectCode(() => runFixture(escaped), "NPM_LOCAL_BIN_ESCAPE");
      assert.equal(readCalls(escaped).length, 1);
    } finally {
      destroyFixture(escaped);
    }

    const binDirectoryEscape = createFixture();
    try {
      mkdirSync(join(binDirectoryEscape.root, "node_modules"), { recursive: true });
      const outsideBin = join(binDirectoryEscape.outer, "outside-bin");
      mkdirSync(outsideBin, { recursive: true });
      symlinkSync(outsideBin, join(binDirectoryEscape.root, "node_modules/.bin"), "dir");
      expectCode(() => runFixture(binDirectoryEscape), "NPM_LOCAL_BIN_ESCAPE");
      assert.equal(readCalls(binDirectoryEscape).length, 1);
    } finally {
      destroyFixture(binDirectoryEscape);
    }

    const entryEscape = createFixture();
    try {
      mkdirSync(join(entryEscape.root, "node_modules/.bin"), { recursive: true });
      const outsideTool = join(entryEscape.outer, "outside-tool.js");
      writeFileSync(outsideTool, "fixture\n", "utf8");
      symlinkSync(outsideTool, join(entryEscape.root, "node_modules/.bin/tool"));
      expectCode(() => runFixture(entryEscape), "NPM_LOCAL_BIN_ESCAPE");
      assert.equal(readCalls(entryEscape).length, 1);
    } finally {
      destroyFixture(entryEscape);
    }

    const confined = createFixture();
    try {
      mkdirSync(join(confined.root, "node_modules/.bin"), { recursive: true });
      mkdirSync(join(confined.root, "node_modules/example-package/bin"), { recursive: true });
      writeFileSync(join(confined.root, "node_modules/example-package/bin/tool.js"), "fixture\n", "utf8");
      symlinkSync("../example-package/bin/tool.js", join(confined.root, "node_modules/.bin/tool"));
      assert.equal(runFixture(confined).profile, "run-script");
    } finally {
      destroyFixture(confined);
    }
  });

  await t.test("blocks hostile effective config and cache before the workload sentinel", () => {
    const cases = [
      [{ configOverride: { "@evil:registry": "https://example.test/" } }, "NPM_EFFECTIVE_SCOPED_REGISTRY"],
      [{ configOverride: { "//registry.npmjs.org/:_authToken": "(protected)" } }, "NPM_EFFECTIVE_CREDENTIAL"],
      [{ configOverride: { proxy: "http://proxy.example.test" } }, "NPM_EFFECTIVE_SENSITIVE"],
      [{ configOverride: { cafile: "/tmp/fixture-ca.pem" } }, "NPM_EFFECTIVE_SENSITIVE"],
      [{ invalidConfigJson: true }, "NPM_EFFECTIVE_CONFIG_JSON"],
      [{ prewarmCache: true }, "NPM_CACHE_PREWARMED"],
    ];
    for (const [behavior, code] of cases) {
      const fixture = createFixture({ behavior });
      try {
        expectCode(() => runFixture(fixture), code);
        const calls = readCalls(fixture);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].args, ["config", "list", "--json"]);
        assert.ok(!existsSync(calls[0].home));
      } finally {
        destroyFixture(fixture);
      }
    }
  });

  await t.test("revalidates project inputs after config preflight", () => {
    const cases = [
      ["package.json", `${JSON.stringify({ ...baseManifest(), fixtureMutation: true }, null, 2)}\n`, "NPM_INPUT_DRIFT"],
      ["npm-shrinkwrap.json", "{}\n", "NPM_LOCK_COMPETING"],
    ];
    for (const [relativePath, mutationText, code] of cases) {
      const fixture = createFixture();
      try {
        updateBehavior(fixture, {
          preflightRootMutation: {
            path: join(fixture.root, relativePath),
            text: mutationText,
          },
        });
        expectCode(() => runFixture(fixture), code);
        const calls = readCalls(fixture);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].args, ["config", "list", "--json"]);
      } finally {
        destroyFixture(fixture);
      }
    }

    const manifest = baseManifest();
    manifest.dependencies = { "example-package": "^1.0.0" };
    const lockfile = validLockfile(manifest);
    const hostileLock = structuredClone(lockfile);
    hostileLock.packages["node_modules/example-package"].resolved = "https://registry.npmmirror.com/example-package.tgz";
    const fixture = createFixture({ manifest });
    try {
      writeJson(join(fixture.root, "package-lock.json"), lockfile);
      updateBehavior(fixture, {
        preflightRootMutation: {
          path: join(fixture.root, "package-lock.json"),
          text: `${JSON.stringify(hostileLock, null, 2)}\n`,
        },
      });
      expectCode(() => runFixture(fixture), "NPM_INPUT_DRIFT");
      assert.equal(readCalls(fixture).length, 1);
    } finally {
      destroyFixture(fixture);
    }
  });

  await t.test("rejects project and runtime mutations before the first npm child", () => {
    const cases = [
      [(fixture) => writeFileSync(join(fixture.root, ".npmrc"), `${expectedNpmrc()}cache=/tmp/cache\n`, "utf8"), "NPM_CONFIG_UNKNOWN"],
      [(fixture) => {
        const manifest = baseManifest();
        manifest.dependencies = { "example-package": "https://example.test/package.tgz" };
        writeJson(join(fixture.root, "package.json"), manifest);
      }, "NPM_MANIFEST_SOURCE"],
      [(fixture) => writeFileSync(join(fixture.root, ".nvmrc"), "0.0.1\n", "utf8"), "NPM_RUNTIME_CONTRACT"],
      [(fixture) => writeFileSync(join(fixture.root, "npm-shrinkwrap.json"), "{}\n", "utf8"), "NPM_LOCK_COMPETING"],
    ];
    for (const [mutate, code] of cases) {
      const fixture = createFixture();
      try {
        mutate(fixture);
        expectCode(() => runFixture(fixture), code);
        assert.deepEqual(readCalls(fixture), []);
      } finally {
        destroyFixture(fixture);
      }
    }
  });

  await t.test("rejects an existing hostile lock before resolve-lock workload", () => {
    const fixture = createFixture();
    try {
      const lockfile = validLockfile(baseManifest());
      lockfile.packages["node_modules/example-package"].resolved = "https://registry.npmmirror.com/example-package.tgz";
      writeJson(join(fixture.root, "package-lock.json"), lockfile);
      expectCode(
        () => runFixture(fixture, { profile: "resolve-lock", scriptName: null }),
        "NPM_LOCK_REGISTRY",
      );
      assert.deepEqual(fixture.invocations, []);
      assert.deepEqual(readCalls(fixture), []);
    } finally {
      destroyFixture(fixture);
    }
  });

  await t.test("wires the real lockfile scanner into the quality gate", () => {
    const manifest = baseManifest();
    manifest.dependencies = { "example-package": "^1.0.0" };
    const lockfile = validLockfile(manifest);
    lockfile.packages["node_modules/example-package"].resolved = "https://registry.npmmirror.com/example-package.tgz";
    const fixture = createFixture({ manifest });
    try {
      writeJson(join(fixture.root, "package-lock.json"), lockfile);
      expectCode(() => checkNpmIsolation(fixture.root), "NPM_LOCK_REGISTRY");
    } finally {
      destroyFixture(fixture);
    }
  });

  await t.test("rejects package-manager bypasses through the complete quality gate", () => {
    for (const workflow of [
      "  - run: \"npm ci\"\n",
      "  - run:\n      npm ci\n",
      "  - {run: npm ci}\n",
      "  - run: >\n      env -u\n      HOME npm ci\n",
    ]) {
      const workflowFixture = createFixture();
      try {
        writeControlledQualityPaths(workflowFixture, {
          workflow: `jobs:\n  website-quality:\n    steps:\n      - run: node scripts/quality/run-quality.mjs\n${workflow}`,
        });
        assert.throws(
          () => checkNpmIsolation(workflowFixture.root),
          /受控质量路径直接调用包管理器/,
        );
      } finally {
        destroyFixture(workflowFixture);
      }
    }

    const manifest = baseManifest();
    manifest.scripts.quality = "exec npm ci";
    const scriptFixture = createFixture({ manifest });
    try {
      writeControlledQualityPaths(scriptFixture);
      expectCode(() => checkNpmIsolation(scriptFixture.root), "NPM_MANIFEST_SCRIPT_BYPASS");
    } finally {
      destroyFixture(scriptFixture);
    }

    for (const command of ["nice npm ci", "timeout 60 npm ci"]) {
      const wrappedManifest = baseManifest();
      wrappedManifest.scripts.quality = command;
      const wrappedFixture = createFixture({ manifest: wrappedManifest });
      try {
        writeControlledQualityPaths(wrappedFixture);
        expectCode(
          () => checkNpmIsolation(wrappedFixture.root),
          "NPM_MANIFEST_SCRIPT_BYPASS",
        );
      } finally {
        destroyFixture(wrappedFixture);
      }
    }

    const operationalFixture = createFixture();
    try {
      writeControlledQualityPaths(operationalFixture);
      writeFileSync(
        join(operationalFixture.root, "README.md"),
        "提交前运行 `npm run quality`。\n",
        "utf8",
      );
      assert.throws(
        () => checkNpmIsolation(operationalFixture.root),
        /受控质量路径直接调用包管理器/,
      );
    } finally {
      destroyFixture(operationalFixture);
    }
  });

  await t.test("publishes the first lock only after candidate validation", () => {
    const manifest = baseManifest();
    manifest.dependencies = { "example-package": "^1.0.0" };
    const candidate = validLockfile(manifest);
    const valid = createFixture({ manifest, behavior: { writeCandidateLock: candidate } });
    try {
      assert.ok(!existsSync(join(valid.root, "package-lock.json")));
      runFixture(valid, { profile: "resolve-lock", scriptName: null });
      assert.equal(
        readFileSync(join(valid.root, "package-lock.json"), "utf8"),
        `${JSON.stringify(candidate, null, 2)}\n`,
      );
      assert.ok(!existsSync(join(valid.root, ".e010-resolve-lock")));
      assert.deepEqual(
        readdirSync(valid.root).filter((name) => name.includes("package-lock.json.e010")),
        [],
      );
    } finally {
      destroyFixture(valid);
    }

    const invalidCandidate = structuredClone(candidate);
    invalidCandidate.packages["node_modules/example-package"].resolved = "https://registry.npmmirror.com/example-package.tgz";
    const invalid = createFixture({ manifest, behavior: { writeCandidateLock: invalidCandidate } });
    try {
      expectCode(
        () => runFixture(invalid, { profile: "resolve-lock", scriptName: null }),
        "NPM_LOCK_REGISTRY",
      );
      assert.ok(!existsSync(join(invalid.root, "package-lock.json")));
      assert.deepEqual(
        readdirSync(invalid.root).filter((name) => name.includes("package-lock.json.e010")),
        [],
      );
      assert.ok(!existsSync(join(invalid.root, ".e010-resolve-lock")));
    } finally {
      destroyFixture(invalid);
    }
  });

  await t.test("restores root state after a post-rename lock publication failure", () => {
    for (const hasExistingLock of [false, true]) {
      const manifest = baseManifest();
      manifest.dependencies = { "example-package": "^1.0.0" };
      const original = validLockfile(manifest);
      const candidate = structuredClone(original);
      candidate.packages["node_modules/example-package"].version = "1.2.4";
      candidate.packages["node_modules/example-package"].resolved =
        "https://registry.npmjs.org/example-package/-/example-package-1.2.4.tgz";
      const fixture = createFixture({ manifest, behavior: { writeCandidateLock: candidate } });
      try {
        const originalText = `${JSON.stringify(original, null, 2)}\n`;
        if (hasExistingLock) writeFileSync(join(fixture.root, "package-lock.json"), originalText, "utf8");
        expectCode(
          () => runFixture(fixture, {
            profile: "resolve-lock",
            scriptName: null,
            publishCandidate(text, root, options) {
              return publishLockfile(text, root, {
                ...options,
                afterRename() {
                  throw new Error("synthetic post-rename failure");
                },
              });
            },
          }),
          "NPM_LOCK_PUBLISH",
        );
        if (hasExistingLock) {
          assert.equal(readFileSync(join(fixture.root, "package-lock.json"), "utf8"), originalText);
        } else {
          assert.ok(!existsSync(join(fixture.root, "package-lock.json")));
        }
        assert.ok(!existsSync(join(fixture.root, ".e010-resolve-lock")));
        assert.deepEqual(
          readdirSync(fixture.root).filter((name) => name.includes("package-lock.json.e010")),
          [],
        );
      } finally {
        destroyFixture(fixture);
      }
    }
  });

  await t.test("does not overwrite a root lock changed in the final publication window", () => {
    for (const hasExistingLock of [false, true]) {
      const manifest = baseManifest();
      manifest.dependencies = { "example-package": "^1.0.0" };
      const candidate = validLockfile(manifest);
      const fixture = createFixture({ manifest, behavior: { writeCandidateLock: candidate } });
      const externalText = "synthetic concurrent lock change\n";
      try {
        if (hasExistingLock) writeJson(join(fixture.root, "package-lock.json"), candidate);
        expectCode(
          () => runFixture(fixture, {
            profile: "resolve-lock",
            scriptName: null,
            publishCandidate(text, root, options) {
              return publishLockfile(text, root, {
                ...options,
                beforeRename() {
                  writeFileSync(join(root, "package-lock.json"), externalText, "utf8");
                },
              });
            },
          }),
          "NPM_LOCK_CONCURRENT_CHANGE",
        );
        assert.equal(
          readFileSync(join(fixture.root, "package-lock.json"), "utf8"),
          externalText,
        );
        assert.ok(!existsSync(join(fixture.root, ".e010-resolve-lock")));
        assert.deepEqual(
          readdirSync(fixture.root).filter((name) => name.includes("package-lock.json.e010")),
          [],
        );
      } finally {
        destroyFixture(fixture);
      }
    }
  });

  await t.test("serializes resolve-lock before any npm child", () => {
    const fixture = createFixture();
    try {
      writeFileSync(join(fixture.root, ".e010-resolve-lock"), "synthetic-holder\n", "utf8");
      expectCode(
        () => runFixture(fixture, { profile: "resolve-lock", scriptName: null }),
        "NPM_RESOLVE_CONCURRENT",
      );
      assert.deepEqual(readCalls(fixture), []);
    } finally {
      destroyFixture(fixture);
    }
  });

  await t.test("publishes only a validated resolve-lock candidate from staging", () => {
    const manifest = baseManifest();
    manifest.dependencies = { "example-package": "^1.0.0" };
    const oldLock = validLockfile(manifest);
    const candidateLock = structuredClone(oldLock);
    candidateLock.packages["node_modules/example-package"].version = "1.3.0";
    candidateLock.packages["node_modules/example-package"].resolved = "https://registry.npmjs.org/example-package/-/example-package-1.3.0.tgz";
    const fixture = createFixture({ manifest, behavior: { writeCandidateLock: candidateLock } });
    const oldText = `${JSON.stringify(oldLock, null, 2)}\n`;
    const candidateText = `${JSON.stringify(candidateLock, null, 2)}\n`;
    try {
      writeFileSync(join(fixture.root, "package-lock.json"), oldText, "utf8");
      const result = runFixture(fixture, { profile: "resolve-lock", scriptName: null });
      assert.equal(result.profile, "resolve-lock");
      assert.equal(readFileSync(join(fixture.root, "package-lock.json"), "utf8"), candidateText);
      const calls = readCalls(fixture);
      assert.equal(calls.length, 2);
      assert.notEqual(calls[1].cwd, fixture.root);
      assert.equal(calls[1].lockBefore, oldText);
      assert.deepEqual(calls[1].args, [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--audit=false",
        "--fund=false",
        "--allow-git=none",
        "--allow-file=none",
        "--allow-directory=none",
        "--allow-remote=none",
      ]);
    } finally {
      destroyFixture(fixture);
    }
  });

  await t.test("keeps the root lock unchanged when a staged candidate is invalid", () => {
    const manifest = baseManifest();
    manifest.dependencies = { "example-package": "^1.0.0" };
    const oldLock = validLockfile(manifest);
    const invalidCandidate = structuredClone(oldLock);
    invalidCandidate.packages["node_modules/example-package"].resolved = "https://registry.npmmirror.com/example-package.tgz";
    const fixture = createFixture({ manifest, behavior: { writeCandidateLock: invalidCandidate } });
    const oldText = `${JSON.stringify(oldLock, null, 2)}\n`;
    try {
      writeFileSync(join(fixture.root, "package-lock.json"), oldText, "utf8");
      expectCode(
        () => runFixture(fixture, { profile: "resolve-lock", scriptName: null }),
        "NPM_LOCK_REGISTRY",
      );
      assert.equal(readFileSync(join(fixture.root, "package-lock.json"), "utf8"), oldText);
    } finally {
      destroyFixture(fixture);
    }
  });

  await t.test("binds a resolve candidate to the initial root manifest", () => {
    const manifest = baseManifest();
    manifest.dependencies = { "example-package": "^1.0.0" };
    const oldLock = validLockfile(manifest);
    const changedManifest = structuredClone(manifest);
    changedManifest.dependencies["example-package"] = "^2.0.0";
    const changedCandidate = validLockfile(changedManifest);
    changedCandidate.packages["node_modules/example-package"].version = "2.1.0";
    changedCandidate.packages["node_modules/example-package"].resolved = "https://registry.npmjs.org/example-package/-/example-package-2.1.0.tgz";
    const fixture = createFixture({
      manifest,
      behavior: {
        writeManifest: changedManifest,
        writeCandidateLock: changedCandidate,
      },
    });
    const oldText = `${JSON.stringify(oldLock, null, 2)}\n`;
    try {
      writeFileSync(join(fixture.root, "package-lock.json"), oldText, "utf8");
      expectCode(
        () => runFixture(fixture, { profile: "resolve-lock", scriptName: null }),
        "NPM_INPUT_DRIFT",
      );
      assert.equal(readFileSync(join(fixture.root, "package-lock.json"), "utf8"), oldText);
    } finally {
      destroyFixture(fixture);
    }
  });

  await t.test("does not overwrite a root lock changed during resolve", () => {
    const manifest = baseManifest();
    manifest.dependencies = { "example-package": "^1.0.0" };
    const oldLock = validLockfile(manifest);
    const candidateLock = structuredClone(oldLock);
    candidateLock.packages["node_modules/example-package"].version = "1.3.0";
    candidateLock.packages["node_modules/example-package"].resolved = "https://registry.npmjs.org/example-package/-/example-package-1.3.0.tgz";
    const concurrentLock = structuredClone(oldLock);
    concurrentLock.packages["node_modules/example-package"].version = "1.4.0";
    concurrentLock.packages["node_modules/example-package"].resolved = "https://registry.npmjs.org/example-package/-/example-package-1.4.0.tgz";
    const concurrentText = `${JSON.stringify(concurrentLock, null, 2)}\n`;
    const fixture = createFixture({
      manifest,
      behavior: {
        writeCandidateLock: candidateLock,
        rootLockMutation: {
          path: "placeholder",
          text: concurrentText,
        },
      },
    });
    const behaviorPath = join(fixture.outer, "behavior.json");
    const behavior = JSON.parse(readFileSync(behaviorPath, "utf8"));
    behavior.rootLockMutation.path = join(fixture.root, "package-lock.json");
    writeJson(behaviorPath, behavior);
    try {
      writeJson(join(fixture.root, "package-lock.json"), oldLock);
      expectCode(
        () => runFixture(fixture, { profile: "resolve-lock", scriptName: null }),
        "NPM_INPUT_DRIFT",
      );
      assert.equal(readFileSync(join(fixture.root, "package-lock.json"), "utf8"), concurrentText);
    } finally {
      destroyFixture(fixture);
    }
  });

  await t.test("fails closed on workload failure and manifest drift", () => {
    for (const [behavior, code] of [
      [{ workloadExitCode: 7 }, "NPM_WORKLOAD_FAILED"],
      [{ mutateManifest: true }, "NPM_INPUT_DRIFT"],
    ]) {
      const fixture = createFixture({ behavior });
      try {
        expectCode(() => runFixture(fixture), code);
        const calls = readCalls(fixture);
        assert.equal(calls.length, 2);
        assert.ok(!existsSync(calls[0].home));
      } finally {
        destroyFixture(fixture);
      }
    }
  });
});
