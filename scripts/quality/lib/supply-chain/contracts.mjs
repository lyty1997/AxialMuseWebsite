export const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";

export const PROJECT_NPM_CONFIG = Object.freeze({
  registry: OFFICIAL_REGISTRY,
  "replace-registry-host": "never",
  "strict-ssl": "true",
  "ignore-scripts": "true",
  audit: "false",
  fund: "false",
  "update-notifier": "false",
  "package-lock": "true",
  "lockfile-version": "3",
});

// Node 版本只从 .nvmrc 与 engines 下界读取；D-073 单独固定各角色随附的 npm。
export const NPM_VERSIONS_BY_ROLE = Object.freeze({
  primary: "11.16.0",
  minimum: "11.13.0",
});

export const RUN_SCRIPT_COMMANDS = Object.freeze({
  quality: Object.freeze(["node scripts/quality/run-quality.mjs"]),
  typecheck: Object.freeze(["tsc --noEmit"]),
  test: Object.freeze([
    "node --test tests/build/run-isolated-npm.test.mjs tests/build/deterministic-spdx.test.mjs",
    "node scripts/quality/run-tests.mjs",
  ]),
  build: Object.freeze(["node scripts/build/build-site.mjs --mode production"]),
  "check:artifact": Object.freeze(["node scripts/quality/check-artifact.mjs"]),
});

export const RUN_SCRIPT_ALLOWLIST = Object.freeze(Object.keys(RUN_SCRIPT_COMMANDS));

export const PROFILE_NAMES = Object.freeze([
  "resolve-lock",
  "ci",
  "audit",
  "sbom-native",
  "run-script",
]);

export const BLOCKED_ENVIRONMENT_KEYS = Object.freeze([
  "node_env",
  "node_extra_ca_certs",
  "ssl_cert_file",
  "ssl_cert_dir",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
]);
