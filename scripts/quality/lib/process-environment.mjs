const QUALITY_CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_REF",
  "GITHUB_REPOSITORY",
  "GITHUB_SHA",
  "GITHUB_WORKSPACE",
  "HOME",
  "LANG",
  "LC_ALL",
  "NPM_CONFIG_AUDIT",
  "NPM_CONFIG_CACHE",
  "NPM_CONFIG_FUND",
  "NPM_CONFIG_GLOBALCONFIG",
  "NPM_CONFIG_IGNORE_SCRIPTS",
  "NPM_CONFIG_LOCKFILE_VERSION",
  "NPM_CONFIG_LOGS_DIR",
  "NPM_CONFIG_PACKAGE_LOCK",
  "NPM_CONFIG_REGISTRY",
  "NPM_CONFIG_REPLACE_REGISTRY_HOST",
  "NPM_CONFIG_STRICT_SSL",
  "NPM_CONFIG_UPDATE_NOTIFIER",
  "NPM_CONFIG_USERCONFIG",
  "PATH",
  "RUNNER_OS",
  "TEMP",
  "TMP",
  "TMPDIR",
]);

export function buildQualityChildEnvironment(source = process.env) {
  const environment = {};
  for (const key of QUALITY_CHILD_ENVIRONMENT_KEYS) {
    if (typeof source[key] === "string") environment[key] = source[key];
  }
  return environment;
}
