export class NpmIsolationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NpmIsolationError";
    this.code = code;
  }
}

export function fail(code, message) {
  throw new NpmIsolationError(code, message);
}

export function formatIsolationError(error) {
  if (error instanceof NpmIsolationError) {
    return `[${error.code}] ${error.message}`;
  }
  return "[NPM_ISOLATION_INTERNAL] 隔离入口发生未分类错误；详细堆栈已抑制，避免泄露本机路径或环境信息。";
}

export function formatSupplyChainError(error) {
  if (error instanceof NpmIsolationError) {
    return `[${error.code}] ${error.message}`;
  }
  return "[SUPPLY_CHAIN_INTERNAL] 供应链入口发生未分类错误；详细堆栈已抑制，避免泄露本机路径或环境信息。";
}
