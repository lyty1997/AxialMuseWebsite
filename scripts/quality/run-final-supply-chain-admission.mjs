#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "./lib/files.mjs";
import { NpmIsolationError, fail } from "./lib/supply-chain/errors.mjs";
import { runFinalSupplyChainAdmission } from "./lib/supply-chain/final-admission-runner.mjs";

const ROOT = realpathSync(projectRoot());
const ARGUMENTS = Object.freeze([
  Object.freeze(["--candidate-report", "candidateReportPath"]),
  Object.freeze(["--candidate-receipt", "candidateReceiptPath"]),
  Object.freeze(["--audit-raw", "auditRawPath"]),
  Object.freeze(["--audit-receipt", "auditReceiptPath"]),
  Object.freeze(["--final-decision", "finalDecisionPath"]),
]);
const SAFE_ERROR_CODE = /^(?:FINAL_ADMISSION|SUPPLY_CHAIN|DUAL_ENDPOINT_CI|NPM_ISOLATION|SPDX_ARTIFACT)_[A-Z0-9_]{1,80}$/;

export function formatFinalSupplyChainAdmissionError(error) {
  const code = error instanceof NpmIsolationError
      && typeof error.code === "string"
      && SAFE_ERROR_CODE.test(error.code)
    ? error.code
    : "FINAL_ADMISSION_INTERNAL";
  return `[${code}] 最终供应链准入失败；证据详情、包身份、本机路径、环境值与子进程输出已抑制。`;
}

function canonicalAbsolutePath(value) {
  return typeof value === "string"
    && isAbsolute(value)
    && resolve(value) === value;
}

export function parseFinalSupplyChainAdmissionArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== ARGUMENTS.length * 2) {
    fail(
      "FINAL_ADMISSION_ARGUMENTS",
      "最终供应链准入入口要求精确的五组受限证据路径参数。",
    );
  }
  const parsed = {};
  for (let index = 0; index < ARGUMENTS.length; index += 1) {
    const [expectedFlag, key] = ARGUMENTS[index];
    const flag = argv[index * 2];
    const value = argv[index * 2 + 1];
    if (flag !== expectedFlag || !canonicalAbsolutePath(value)) {
      fail(
        "FINAL_ADMISSION_ARGUMENTS",
        "最终供应链准入参数名称、顺序或绝对规范路径不合法。",
      );
    }
    parsed[key] = value;
  }
  if (new Set(Object.values(parsed)).size !== ARGUMENTS.length) {
    fail("FINAL_ADMISSION_ARGUMENTS", "最终供应链准入的五个证据文件路径必须互不相同。");
  }
  return Object.freeze(parsed);
}

export async function main(
  argv = process.argv.slice(2),
  {
    runAdmission = runFinalSupplyChainAdmission,
    standardError = process.stderr,
    standardOutput = process.stdout,
    ...unknownOptions
  } = {},
) {
  if (
    Object.keys(unknownOptions).length !== 0
    || typeof runAdmission !== "function"
    || standardError === null
    || typeof standardError?.write !== "function"
    || standardOutput === null
    || typeof standardOutput?.write !== "function"
  ) {
    fail("FINAL_ADMISSION_CLI_OPTIONS", "最终供应链准入 CLI 依赖不合法。");
  }
  try {
    const paths = parseFinalSupplyChainAdmissionArguments(argv);
    const result = await runAdmission({ root: ROOT, ...paths });
    standardOutput.write(
      `最终供应链准入通过。\nComposite receipt: ${result.receiptPath}\nDual-endpoint receipt: ${result.dualEndpointReceiptPath}\n`,
    );
    return result;
  } catch (error) {
    standardError.write(`${formatFinalSupplyChainAdmissionError(error)}\n`);
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch {
    process.exitCode = 1;
  }
}
