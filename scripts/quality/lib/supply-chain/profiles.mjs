import { PROFILE_NAMES, RUN_SCRIPT_ALLOWLIST } from "./contracts.mjs";
import { fail } from "./errors.mjs";

export function parseProfileArguments(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.length === 0) {
    fail("NPM_PROFILE_REQUIRED", `必须选择封闭 profile：${PROFILE_NAMES.join(", ")}。`);
  }
  const [profile, ...rest] = arguments_;
  if (!PROFILE_NAMES.includes(profile)) {
    fail("NPM_PROFILE_UNKNOWN", "未知 npm 隔离 profile。" );
  }

  if (profile === "run-script") {
    if (rest.length !== 1 || !RUN_SCRIPT_ALLOWLIST.includes(rest[0])) {
      fail("NPM_PROFILE_SCRIPT", `run-script 只接受：${RUN_SCRIPT_ALLOWLIST.join(", ")}。`);
    }
    return { profile, scriptName: rest[0] };
  }
  if (rest.length !== 0) {
    fail("NPM_PROFILE_ARGUMENTS", `${profile} 不接受调用者参数。`);
  }
  return { profile, scriptName: null };
}

export function buildProfileArguments({ profile, scriptName, runtimeRole, manifest }) {
  switch (profile) {
    case "resolve-lock":
      if (runtimeRole !== "primary") {
        fail("NPM_PROFILE_PRIMARY_ONLY", "resolve-lock 只允许 D-073 主 npm 端点执行。" );
      }
      return [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--audit=false",
        "--fund=false",
        "--allow-git=none",
        "--allow-file=none",
        "--allow-directory=none",
        "--allow-remote=none",
      ];
    case "ci":
      return ["ci", "--ignore-scripts", "--audit=false", "--fund=false"];
    case "audit":
      return ["audit", "--include=dev", "--audit-level=moderate", "--json"];
    case "sbom-native":
      return [
        "sbom",
        "--package-lock-only",
        "--sbom-format=spdx",
        "--sbom-type=application",
        "--offline",
      ];
    case "run-script":
      if (!RUN_SCRIPT_ALLOWLIST.includes(scriptName)) {
        fail("NPM_PROFILE_SCRIPT", `run-script 只接受：${RUN_SCRIPT_ALLOWLIST.join(", ")}。`);
      }
      if (!Object.hasOwn(manifest.scripts ?? {}, scriptName)) {
        fail("NPM_PROFILE_SCRIPT_MISSING", `package.json 未声明受控脚本 ${scriptName}。`);
      }
      return ["run", scriptName];
    default:
      fail("NPM_PROFILE_UNKNOWN", "未知 npm 隔离 profile。" );
  }
}

export function profileRequiresLockfile(profile) {
  return profile === "ci" || profile === "audit" || profile === "sbom-native";
}
