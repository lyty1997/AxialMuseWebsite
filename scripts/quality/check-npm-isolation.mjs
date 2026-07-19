import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  findShellPackageManagerCommands,
  findWorkflowPackageManagerCommands,
  hasDirectPackageManagerCommand,
} from "./lib/supply-chain/bypass.mjs";
import {
  assertNoCompetingPackageManagerInputs,
  readAndValidateRuntimeContract,
  readAndValidateManifest,
  validateProjectNpmrc,
} from "./lib/supply-chain/config.mjs";
import { formatIsolationError } from "./lib/supply-chain/errors.mjs";
import { readAndValidateLockfile } from "./lib/supply-chain/lockfile.mjs";
import { projectRoot } from "./lib/files.mjs";
import { QUALITY_COMMANDS } from "./run-quality.mjs";

const ROOT = projectRoot();
const QUALITY_ENTRY_COMMANDS = Object.freeze([
  "node scripts/quality/run-quality.mjs",
  "node scripts/quality/run-isolated-npm.mjs run-script quality",
]);

export const OPERATIONAL_NPM_BOUNDARY_PATHS = Object.freeze([
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "CONTRIBUTING.md",
  ".github/pull_request_template.md",
  "docs/README.md",
  "codex-rules/global-AGENTS.md",
  "codex-rules/rules/quality-gates.md",
  "codex-rules/rules/codex-workflow.md",
  "codex-rules/rules/git-workflow.md",
  "docs/operations/content-publishing.md",
  "docs/operations/maintenance.md",
  "docs/product/m0-main-site-spec.md",
  "docs/product/site-experience.md",
]);

const PACKAGE_MANAGER_SUBCOMMAND = "(?:audit|cache|ci|config|dedupe|exec|i|init|install|link|login|logout|ls|outdated|pack|ping|prune|publish|rebuild|run(?:-script)?|sbom|start|stop|test|un|uninstall|unpublish|up|update|version|view|whoami)";
const PROSE_PACKAGE_MANAGER_INVOCATION = new RegExp(
  `(?:^|[\\s;\"'|&()])(?:[^\\s;\"'|&()]+/)*(?:npm|npm-cli\\.js|pnpm|yarn|bun|corepack)\\s+(?:--?[A-Za-z][A-Za-z0-9-]*(?:=[^\\s]+)?\\s+)*${PACKAGE_MANAGER_SUBCOMMAND}(?=$|[\\s;\"'|&()。.，,：:])`,
  "i",
);
const PROSE_PACKAGE_EXECUTOR_INVOCATION = /(?:^|[\s;"'|&()])(?:[^\s;"'|&()]+\/)*(?:npx|npx-cli\.js|bunx)\s+[^\s`]+/i;

function hasExplicitOperationalPackageManagerInvocation(text) {
  const match = PROSE_PACKAGE_MANAGER_INVOCATION.exec(text)
    ?? PROSE_PACKAGE_EXECUTOR_INVOCATION.exec(text);
  if (match === null) return false;
  const prefix = text.slice(0, match.index);
  if (/^\s*(?:[-*+]|\d+[.)])?\s*[$>]?\s*$/.test(prefix)) return true;
  const cue = /(?:运行|执行|调用|输入|键入|命令|run)([^。；;\n]*)$/i.exec(prefix);
  return cue !== null
    && !/\b(?:npm|npx|pnpm|yarn|bun|bunx|corepack)\b/i.test(cue[1]);
}

export function findOperationalPackageManagerCommands(text) {
  const findings = new Map();
  let fence = null;
  let scanFence = false;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const closingFence = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
    const openingFence = /^\s*(`{3,}|~{3,})\s*([^\s`]*)[^\r\n]*$/.exec(line);
    if (fence !== null && closingFence?.[1][0] === fence) {
      fence = null;
      scanFence = false;
      continue;
    }
    if (fence === null && openingFence) {
      fence = openingFence[1][0];
      scanFence = /^(?:|bash|console|sh|shell|shell-session|terminal|zsh)$/.test(openingFence[2].toLowerCase());
      continue;
    }
    if (fence !== null) {
      if (scanFence && hasDirectPackageManagerCommand(line)) {
        findings.set(index + 1, { line: index + 1, command: line.trim() });
      }
      continue;
    }
    if (hasExplicitOperationalPackageManagerInvocation(line)) {
      findings.set(index + 1, { line: index + 1, command: line.trim() });
    }
    for (const match of line.matchAll(/`([^`\r\n]+)`/g)) {
      if (
        hasExplicitOperationalPackageManagerInvocation(match[1])
        && hasDirectPackageManagerCommand(match[1])
      ) {
        findings.set(index + 1, { line: index + 1, command: match[1] });
      }
    }
  }
  return [...findings.values()].sort((left, right) => left.line - right.line);
}

function extractWorkflowJob(text, jobName) {
  const lines = text.split(/\r?\n/);
  const jobsHeaders = lines.flatMap((line, index) => {
    const match = /^(\s*)(?:"jobs"|'jobs'|jobs)\s*:\s*(?:#.*)?$/.exec(line);
    return match && match[1].length === 0 ? [{ index, indentation: 0 }] : [];
  });
  if (jobsHeaders.length !== 1) return null;
  const [{ index: jobsIndex, indentation: jobsIndentation }] = jobsHeaders;
  let jobsEnd = jobsIndex + 1;
  while (jobsEnd < lines.length) {
    const line = lines[jobsEnd];
    if (line.trim() !== "" && !line.trimStart().startsWith("#") && line.match(/^\s*/)[0].length <= jobsIndentation) {
      break;
    }
    jobsEnd += 1;
  }
  const childIndentation = lines
    .slice(jobsIndex + 1, jobsEnd)
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
    .reduce((minimum, line) => Math.min(minimum, line.match(/^\s*/)[0].length), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(childIndentation) || childIndentation <= jobsIndentation) return null;

  const headers = lines.slice(jobsIndex + 1, jobsEnd).flatMap((line, offset) => {
    const match = new RegExp(`^(\\s*)(?:"${jobName}"|'${jobName}'|${jobName})\\s*:\\s*(?:#.*)?$`).exec(line);
    return match && match[1].length === childIndentation
      ? [{ index: jobsIndex + 1 + offset, indentation: childIndentation }]
      : [];
  });
  if (headers.length !== 1) return null;
  const [{ index, indentation }] = headers;
  let end = index + 1;
  while (end < jobsEnd) {
    const line = lines[end];
    if (line.trim() !== "" && !line.trimStart().startsWith("#") && line.match(/^\s*/)[0].length <= indentation) {
      break;
    }
    end += 1;
  }
  return lines.slice(index + 1, end);
}

function indentationOf(line) {
  return line.match(/^\s*/)[0].length;
}

function directProperty(line, indentation, { sequenceItem = false } = {}) {
  if (indentationOf(line) !== indentation) return null;
  const prefix = sequenceItem ? "-\\s+" : "";
  const key = "(?:\\\"([A-Za-z][A-Za-z0-9-]*)\\\"|'([A-Za-z][A-Za-z0-9-]*)'|([A-Za-z][A-Za-z0-9-]*))";
  const match = new RegExp(`^\\s*${prefix}${key}\\s*:\\s*(.*)$`).exec(line);
  return match ? { key: match[1] ?? match[2] ?? match[3], value: match[4] } : null;
}

function extractWorkflowSteps(jobLines) {
  const structuralLines = jobLines.filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  if (structuralLines.length === 0) return null;
  const jobIndentation = Math.min(...structuralLines.map(indentationOf));
  const forbiddenJobKeys = new Set(["continue-on-error", "defaults", "env", "if", "needs"]);
  for (const line of structuralLines) {
    const property = directProperty(line, jobIndentation);
    if (indentationOf(line) === jobIndentation && property === null) return null;
    if (property && forbiddenJobKeys.has(property.key)) return null;
  }

  const headers = jobLines.flatMap((line, index) => {
    const property = directProperty(line, jobIndentation);
    return property?.key === "steps" && property.value.replace(/\s+#.*$/, "") === ""
      ? [index]
      : [];
  });
  if (headers.length !== 1) return null;
  const [header] = headers;
  let end = header + 1;
  while (end < jobLines.length) {
    const line = jobLines[end];
    if (line.trim() !== "" && !line.trimStart().startsWith("#") && indentationOf(line) <= jobIndentation) break;
    end += 1;
  }

  const body = jobLines.slice(header + 1, end);
  const meaningful = body.filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  if (meaningful.length === 0) return null;
  const itemIndentation = Math.min(...meaningful.map(indentationOf));
  const starts = body.flatMap((line, index) =>
    directProperty(line, itemIndentation, { sequenceItem: true }) ? [index] : [],
  );
  if (starts.length === 0) return null;
  if (meaningful.some((line) =>
    indentationOf(line) === itemIndentation
    && directProperty(line, itemIndentation, { sequenceItem: true }) === null,
  )) return null;

  return starts.map((start, position) => {
    const finish = starts[position + 1] ?? body.length;
    const lines = body.slice(start, finish);
    const properties = [];
    const first = directProperty(lines[0], itemIndentation, { sequenceItem: true });
    if (first) properties.push(first);
    for (const line of lines.slice(1)) {
      const property = directProperty(line, itemIndentation + 2);
      if (
        line.trim() !== ""
        && !line.trimStart().startsWith("#")
        && indentationOf(line) === itemIndentation + 2
        && property === null
      ) {
        return null;
      }
      if (property) properties.push(property);
    }
    return properties;
  });
}

function hasUnconditionalQualityStep(jobLines) {
  const steps = extractWorkflowSteps(jobLines);
  if (steps === null) return false;
  const forbiddenStepKeys = new Set(["continue-on-error", "env", "if", "shell", "working-directory"]);
  return steps.filter((properties) => {
    if (properties === null) return false;
    const runProperties = properties.filter(({ key }) => key === "run");
    if (runProperties.length !== 1) return false;
    if (properties.some(({ key }) => forbiddenStepKeys.has(key))) return false;
    return QUALITY_ENTRY_COMMANDS.includes(runProperties[0].value);
  }).length === 1;
}

function hasTopLevelRuntimeOverride(text) {
  return text.split(/\r?\n/).some((line) => {
    if (line.trim() === "" || line.trimStart().startsWith("#") || indentationOf(line) !== 0) return false;
    return /^(?:"env"|'env'|env|"defaults"|'defaults'|defaults)\s*:/.test(line);
  });
}

function assertQualityTopology(root, hookPath) {
  const checkerCount = QUALITY_COMMANDS
    .filter((command) => command.length === 1 && command[0] === "scripts/quality/check-npm-isolation.mjs")
    .length;
  const testCount = QUALITY_COMMANDS
    .filter((command) => command.join(" ") === "--test tests/build/run-isolated-npm.test.mjs")
    .length;
  if (checkerCount !== 1 || testCount !== 1) {
    throw new Error("质量聚合入口必须精确包含一次 npm 隔离门禁和一次 E-010 测试入口。");
  }

  const ciPath = resolve(root, ".github/workflows/ci.yml");
  const ciText = existsSync(ciPath) ? readFileSync(ciPath, "utf8") : null;
  const qualityJob = ciText === null ? null : extractWorkflowJob(ciText, "website-quality");
  const workflowHasQuality = ciText !== null
    && !hasTopLevelRuntimeOverride(ciText)
    && qualityJob !== null
    && hasUnconditionalQualityStep(qualityJob);
  const hookLines = readFileSync(hookPath, "utf8").split(/\r?\n/).map((line) => line.trim());
  const hookHasQuality = QUALITY_ENTRY_COMMANDS.some((command) => hookLines.includes(command));
  if (!workflowHasQuality || !hookHasQuality) {
    throw new Error("CI 与 pre-commit 必须接入同一个受控质量入口。");
  }
}

export function checkNpmIsolation(root) {
  validateProjectNpmrc(root);
  const manifest = readAndValidateManifest(root);
  readAndValidateRuntimeContract({ root, manifest });
  assertNoCompetingPackageManagerInputs(root);
  if (existsSync(join(root, "package-lock.json"))) {
    readAndValidateLockfile(root, manifest);
  }

  const workflowRoot = resolve(root, ".github/workflows");
  const targets = readdirSync(workflowRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => ({
      path: resolve(workflowRoot, entry.name),
      scan: findWorkflowPackageManagerCommands,
    }));
  const workflowTargets = [...targets];
  const hookPath = resolve(root, ".githooks/pre-commit");
  targets.push({
    path: hookPath,
    scan: findShellPackageManagerCommands,
  });
  for (const path of OPERATIONAL_NPM_BOUNDARY_PATHS) {
    targets.push({
      path: resolve(root, path),
      scan: findOperationalPackageManagerCommands,
    });
  }
  assertQualityTopology(root, hookPath);

  const findings = [];
  for (const target of targets) {
    for (const finding of target.scan(readFileSync(target.path, "utf8"))) {
      findings.push(`${relative(root, target.path)}:${finding.line}`);
    }
  }
  if (findings.length > 0) {
    throw new Error(`受控质量路径直接调用包管理器：\n${findings.map((item) => `- ${item}`).join("\n")}`);
  }
}

function main() {
  try {
    checkNpmIsolation(ROOT);
    console.log("npm isolation bypass checks passed.");
  } catch (error) {
    if (error?.code) {
      console.error(formatIsolationError(error));
    } else {
      console.error(error instanceof Error ? error.message : "npm isolation bypass check failed.");
    }
    process.exit(1);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
