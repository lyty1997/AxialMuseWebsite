import { Agent as HttpsAgent, request as requestHttps } from "node:https";
import { rootCertificates } from "node:tls";
import { OFFICIAL_REGISTRY } from "./contracts.mjs";
import { NpmIsolationError, fail } from "./errors.mjs";
import { exactPackageIdentity } from "./lockfile.mjs";
import { inspectPackageTarball, TARBALL_LIMITS } from "./tarball.mjs";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_BODY_HARD_TIMEOUT_MS = 300_000;
const TRANSIENT_DOWNLOAD_ATTEMPTS = 3;
const TRANSIENT_DOWNLOAD_CODES = new Set([
  "SUPPLY_CHAIN_TARBALL_DOWNLOAD_NETWORK",
  "SUPPLY_CHAIN_TARBALL_DOWNLOAD_TIMEOUT",
]);
const RESPONSE_HEADER_VALUE = /^[\x20-\x7e]+$/;
export const TARBALL_REVIEW_LIMITS = Object.freeze({
  concurrentDownloads: 4,
  evidenceBytes: 64 * 1024 * 1024,
  packages: 50_000,
});

function createTaskPrivateAgent(maxConcurrentDownloads) {
  return new HttpsAgent({
    ca: rootCertificates,
    keepAlive: true,
    keepAliveMsecs: 1_000,
    maxCachedSessions: 0,
    maxFreeSockets: maxConcurrentDownloads,
    maxSockets: maxConcurrentDownloads,
    maxTotalSockets: maxConcurrentDownloads,
    rejectUnauthorized: true,
    scheduling: "lifo",
  });
}

async function downloadWithTransientRetry(download, lockedPackage, options) {
  let lastError;
  for (let attempt = 1; attempt <= TRANSIENT_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await download(lockedPackage, options);
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof NpmIsolationError)
        || !TRANSIENT_DOWNLOAD_CODES.has(error.code)
        || attempt === TRANSIENT_DOWNLOAD_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
  throw lastError;
}

function validateLockedDownload(lockedPackage) {
  if (lockedPackage === null || typeof lockedPackage !== "object" || Array.isArray(lockedPackage)) {
    fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_INPUT", "tarball 下载输入必须是 locked package object。" );
  }
  const identity = exactPackageIdentity(lockedPackage.name, lockedPackage.version);
  if (lockedPackage.identity !== identity || typeof lockedPackage.resolved !== "string") {
    fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_INPUT", "tarball 下载输入身份不完整。" );
  }
  let url;
  try {
    url = new URL(lockedPackage.resolved);
  } catch {
    fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_INPUT", `${identity} resolved 不是合法 URL。`);
  }
  if (
    url.href !== lockedPackage.resolved
    || url.origin !== OFFICIAL_REGISTRY.slice(0, -1)
    || url.protocol !== "https:"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_SOURCE", `${identity} 不是精确官方 registry tarball URL。`);
  }
  const tarName = lockedPackage.name.includes("/")
    ? lockedPackage.name.split("/")[1]
    : lockedPackage.name;
  if (url.pathname !== `/${lockedPackage.name}/-/${tarName}-${lockedPackage.version}.tgz`) {
    fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_SOURCE", `${identity} resolved 与精确包身份不一致。`);
  }
  return { identity, url };
}

function singleHeader(headers, name) {
  const value = headers?.[name];
  if (value === undefined) return null;
  if (Array.isArray(value) || typeof value !== "string" || !RESPONSE_HEADER_VALUE.test(value)) {
    fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_RESPONSE", `${name} response header 不规范。`);
  }
  return value;
}

function createResponseTerminator(response) {
  let terminated = false;
  return () => {
    if (terminated) return;
    terminated = true;
    if (response === null || typeof response !== "object") return;

    let body;
    try {
      body = response.body;
    } catch {
      body = null;
    }
    if (typeof body?.destroy === "function") {
      try {
        body.destroy();
      } catch {
        // 继续尝试响应级终止；清理异常不得覆盖原始稳定错误。
      }
    }
    try {
      if (typeof response.abort === "function") response.abort();
    } catch {
      // 清理属于 best effort，调用方仍须收到原始稳定错误。
    }
  };
}

function defaultRequest({ agent = false, url, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = requestHttps({
      agent,
      ca: rootCertificates,
      headers: {
        accept: "application/octet-stream",
        "accept-encoding": "identity",
        "user-agent": "AxialMuseWebsite-supply-chain-review/0.1.0",
      },
      hostname: url.hostname,
      method: "GET",
      path: url.pathname,
      port: 443,
      protocol: "https:",
      rejectUnauthorized: true,
      servername: url.hostname,
    }, (response) => {
      if (settled) {
        response.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        abort: () => response.destroy(),
        body: response,
        headers: response.headers,
        statusCode: response.statusCode,
        url: url.href,
      });
    });
    const timer = setTimeout(() => {
      request.destroy(new Error("controlled tarball request timeout"));
    }, timeoutMs);
    timer.unref();
    request.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    request.end();
  });
}

export async function downloadRegistryTarball(lockedPackage, {
  agent = false,
  bodyHardTimeoutMs = DEFAULT_BODY_HARD_TIMEOUT_MS,
  request = defaultRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const { identity, url } = validateLockedDownload(lockedPackage);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_INPUT", "tarball 下载 timeout 超出受控范围。" );
  }
  if (
    !Number.isSafeInteger(bodyHardTimeoutMs)
    || bodyHardTimeoutMs < timeoutMs
    || bodyHardTimeoutMs > DEFAULT_BODY_HARD_TIMEOUT_MS
  ) {
    fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_INPUT", "tarball 正文硬超时超出受控范围。" );
  }
  let response;
  try {
    response = await request({ agent, timeoutMs, url });
  } catch (error) {
    if (error instanceof NpmIsolationError) throw error;
    fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_NETWORK", `${identity} tarball HTTPS 请求失败。`);
  }
  const terminate = createResponseTerminator(response);
  let declaredLength = null;
  try {
    if (
      response === null
      || typeof response !== "object"
      || response.statusCode !== 200
      || response.url !== url.href
      || response.body === null
      || typeof response.body?.[Symbol.asyncIterator] !== "function"
    ) {
      fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_RESPONSE", `${identity} tarball response 状态或来源不受支持。`);
    }
    if (singleHeader(response.headers, "location") !== null) {
      fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_REDIRECT", `${identity} tarball response 不允许 redirect location。`);
    }
    const contentEncoding = singleHeader(response.headers, "content-encoding");
    if (contentEncoding !== null && contentEncoding !== "identity") {
      fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_RESPONSE", `${identity} tarball response 不允许 HTTP 内容编码。`);
    }
    const lengthHeader = singleHeader(response.headers, "content-length");
    if (lengthHeader !== null) {
      if (!/^(?:0|[1-9]\d*)$/.test(lengthHeader)) {
        fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_RESPONSE", `${identity} content-length 不规范。`);
      }
      declaredLength = Number(lengthHeader);
      if (
        !Number.isSafeInteger(declaredLength)
        || declaredLength === 0
        || declaredLength > TARBALL_LIMITS.compressedBytes
      ) {
        fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_LIMIT", `${identity} content-length 超出受控范围。`);
      }
    }
  } catch (error) {
    terminate();
    if (error instanceof NpmIsolationError) throw error;
    fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_RESPONSE", `${identity} tarball response 无法验证。`);
  }

  const chunks = [];
  let received = 0;
  let bodyHardTimer;
  let bodyIdleTimer;
  let bodyTimedOut = false;
  let iterator;
  let iteratorReturnRequested = false;
  const returnIteratorQuietly = () => {
    if (iteratorReturnRequested) return;
    iteratorReturnRequested = true;
    try {
      if (typeof iterator?.return === "function") {
        Promise.resolve(iterator.return()).catch(() => {});
      }
    } catch {
      // 响应终止继续兜住 iterator 清理；不得覆盖原始稳定错误。
    }
  };
  try {
    let rejectTimeout;
    const timeout = new Promise((_, reject) => {
      rejectTimeout = reject;
    });
    const failBodyTimeout = () => {
      if (bodyTimedOut) return;
      bodyTimedOut = true;
      terminate();
      returnIteratorQuietly();
      rejectTimeout(new NpmIsolationError(
        "SUPPLY_CHAIN_TARBALL_DOWNLOAD_TIMEOUT",
        `${identity} tarball response 超时。`,
      ));
    };
    const refreshBodyIdleTimer = () => {
      if (bodyIdleTimer !== undefined) clearTimeout(bodyIdleTimer);
      bodyIdleTimer = setTimeout(failBodyTimeout, timeoutMs);
      bodyIdleTimer.unref();
    };
    const collect = async () => {
      iterator = response.body[Symbol.asyncIterator]();
      while (true) {
        const result = await iterator.next();
        if (bodyTimedOut) return;
        if (result.done) return;
        const chunkInput = result.value;
        if (!(Buffer.isBuffer(chunkInput) || chunkInput instanceof Uint8Array)) {
          fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_RESPONSE", `${identity} response body chunk 不是 bytes。`);
        }
        const chunk = Buffer.from(chunkInput);
        if (chunk.length === 0) {
          fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_RESPONSE", `${identity} response body 包含空 chunk。`);
        }
        const nextReceived = received + chunk.length;
        if (nextReceived > TARBALL_LIMITS.compressedBytes) {
          chunk.fill(0);
          fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_LIMIT", `${identity} tarball 超过压缩字节上限。`);
        }
        received = nextReceived;
        chunks.push(chunk);
        refreshBodyIdleTimer();
      }
    };
    refreshBodyIdleTimer();
    bodyHardTimer = setTimeout(failBodyTimeout, bodyHardTimeoutMs);
    bodyHardTimer.unref();
    await Promise.race([collect(), timeout]);
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    terminate();
    returnIteratorQuietly();
    if (error instanceof NpmIsolationError) throw error;
    fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_NETWORK", `${identity} tarball response 读取失败。`);
  } finally {
    if (bodyHardTimer !== undefined) clearTimeout(bodyHardTimer);
    if (bodyIdleTimer !== undefined) clearTimeout(bodyIdleTimer);
  }
  if (received === 0 || (declaredLength !== null && received !== declaredLength)) {
    for (const chunk of chunks) chunk.fill(0);
    terminate();
    fail("SUPPLY_CHAIN_TARBALL_DOWNLOAD_RESPONSE", `${identity} tarball response 长度不一致。`);
  }
  const tarball = Buffer.concat(chunks, received);
  for (const chunk of chunks) chunk.fill(0);
  return tarball;
}

export async function reviewLockedPackageTarballs({
  lockedPackages,
  licenseEvidence = null,
  download = downloadRegistryTarball,
  inspect = inspectPackageTarball,
  validateInspection = null,
  maxConcurrentDownloads = TARBALL_REVIEW_LIMITS.concurrentDownloads,
  maxEvidenceBytes = TARBALL_REVIEW_LIMITS.evidenceBytes,
}) {
  if (
    !Array.isArray(lockedPackages)
    || lockedPackages.length > TARBALL_REVIEW_LIMITS.packages
    || typeof download !== "function"
    || typeof inspect !== "function"
    || (validateInspection !== null && typeof validateInspection !== "function")
    || (licenseEvidence !== null && (
      typeof licenseEvidence !== "object"
      || Array.isArray(licenseEvidence)
      || typeof licenseEvidence.legalEvidence !== "object"
      || licenseEvidence.legalEvidence === null
      || Array.isArray(licenseEvidence.legalEvidence)
    ))
    || !Number.isSafeInteger(maxConcurrentDownloads)
    || maxConcurrentDownloads < 1
    || maxConcurrentDownloads > TARBALL_REVIEW_LIMITS.concurrentDownloads
    || !Number.isSafeInteger(maxEvidenceBytes)
    || maxEvidenceBytes < 1
    || maxEvidenceBytes > TARBALL_REVIEW_LIMITS.evidenceBytes
  ) {
    fail("SUPPLY_CHAIN_TARBALL_REVIEW_INPUT", "tarball review 输入超出受控范围。" );
  }
  for (const lockedPackage of lockedPackages) validateLockedDownload(lockedPackage);
  const ordered = [...lockedPackages].sort((left, right) => Buffer.compare(
    Buffer.from(left.identity, "utf8"),
    Buffer.from(right.identity, "utf8"),
  ));
  if (new Set(ordered.map((package_) => package_.identity)).size !== ordered.length) {
    fail("SUPPLY_CHAIN_TARBALL_REVIEW_INPUT", "lockedPackages 包含重复身份。" );
  }
  if (ordered.length === 0) return [];

  const agent = createTaskPrivateAgent(maxConcurrentDownloads);
  const inspections = [];
  let accumulatedEvidenceBytes = 0;
  let pendingError;
  try {
    for (let offset = 0; offset < ordered.length; offset += maxConcurrentDownloads) {
      const batch = ordered.slice(offset, offset + maxConcurrentDownloads);
      const downloads = await Promise.allSettled(batch.map(
        (lockedPackage) => downloadWithTransientRetry(download, lockedPackage, { agent }),
      ));

      try {
        for (const [index, result] of downloads.entries()) {
          if (result.status === "rejected") throw result.reason;
          if (!Buffer.isBuffer(result.value)) {
            fail(
              "SUPPLY_CHAIN_TARBALL_REVIEW_INPUT",
              `${batch[index].identity} 下载结果不是 Buffer。`,
            );
          }
        }

        for (const [index, result] of downloads.entries()) {
          const lockedPackage = batch[index];
          const inspection = inspect(
            result.value,
            lockedPackage,
            licenseEvidence?.legalEvidence[lockedPackage.identity] ?? null,
          );
          if (validateInspection !== null) {
            validateInspection({ inspection, lockedPackage });
          }
          let serialized;
          try {
            serialized = JSON.stringify(inspection);
          } catch {
            fail("SUPPLY_CHAIN_TARBALL_REVIEW_INPUT", "tarball inspection 无法序列化。" );
          }
          if (typeof serialized !== "string") {
            fail("SUPPLY_CHAIN_TARBALL_REVIEW_INPUT", "tarball inspection 不是可序列化证据。" );
          }
          accumulatedEvidenceBytes += Buffer.byteLength(serialized, "utf8");
          if (accumulatedEvidenceBytes > maxEvidenceBytes) {
            fail("SUPPLY_CHAIN_TARBALL_REVIEW_LIMIT", "候选 tarball inspection 累计超过受控内存上限。" );
          }
          inspections.push(inspection);
        }
      } finally {
        for (const result of downloads) {
          if (result.status === "fulfilled" && Buffer.isBuffer(result.value)) {
            result.value.fill(0);
          }
        }
      }
    }
    return inspections;
  } catch (error) {
    pendingError = error;
    throw error;
  } finally {
    try {
      agent.destroy();
    } catch {
      if (pendingError instanceof NpmIsolationError) {
        fail(
          "SUPPLY_CHAIN_TARBALL_REVIEW_AGENT_CLEANUP",
          `${pendingError.code} 后任务私有 HTTPS agent 无法确认清理。`,
        );
      }
      fail(
        "SUPPLY_CHAIN_TARBALL_REVIEW_AGENT_CLEANUP",
        "任务私有 HTTPS agent 无法确认清理。",
      );
    }
  }
}
