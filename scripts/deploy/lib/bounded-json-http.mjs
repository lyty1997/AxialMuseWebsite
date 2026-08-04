import {request as httpsRequest} from "node:https";
import {TextDecoder} from "node:util";

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MILLISECONDS = 15_000;

export class BoundedJsonHttpError extends Error {
  constructor(code) {
    super("受控 JSON HTTPS 请求失败。");
    this.name = "BoundedJsonHttpError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: undefined,
      writable: false,
    });
  }
}

function fail(code) {
  throw new BoundedJsonHttpError(code);
}

function validateHeaders(headers) {
  if (
    headers === null
    || typeof headers !== "object"
    || Array.isArray(headers)
  ) {
    fail("HTTP_HEADERS");
  }
  const validated = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      !/^[A-Za-z0-9-]+$/u.test(name)
      || typeof value !== "string"
      || value.length === 0
      || value.length > 16_384
      || /[\0\r\n]/u.test(value)
    ) {
      fail("HTTP_HEADERS");
    }
    validated[name] = value;
  }
  return Object.freeze(validated);
}

function validateRequestOptions({
  hostname,
  path,
  method,
  headers,
  body,
  timeoutMilliseconds,
  maxResponseBytes,
  signal,
}) {
  if (
    typeof hostname !== "string"
    || !/^[a-z0-9.-]+$/u.test(hostname)
    || hostname.startsWith(".")
    || hostname.endsWith(".")
    || hostname.includes("..")
    || typeof path !== "string"
    || !path.startsWith("/")
    || path.includes("\0")
    || path.includes("\r")
    || path.includes("\n")
    || !["GET", "POST"].includes(method)
    || typeof body !== "string"
    || !Number.isSafeInteger(timeoutMilliseconds)
    || timeoutMilliseconds < 1
    || timeoutMilliseconds > 60_000
    || !Number.isSafeInteger(maxResponseBytes)
    || maxResponseBytes < 1
    || maxResponseBytes > 8 * 1024 * 1024
    || (
      signal !== undefined
      && (
        signal === null
        || typeof signal !== "object"
        || typeof signal.addEventListener !== "function"
        || typeof signal.removeEventListener !== "function"
      )
    )
  ) {
    fail("HTTP_OPTIONS");
  }
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (
    (method === "GET" && bodyBytes !== 0)
    || bodyBytes > 128 * 1024
  ) {
    fail("HTTP_BODY");
  }
  return Object.freeze({
    body,
    bodyBytes,
    headers: validateHeaders(headers),
    hostname,
    maxResponseBytes,
    method,
    path,
    signal,
    timeoutMilliseconds,
  });
}

function parseContentLength(value, maximum) {
  if (value === undefined) return;
  if (
    Array.isArray(value)
    || typeof value !== "string"
    || !/^(?:0|[1-9][0-9]*)$/u.test(value)
  ) {
    fail("HTTP_RESPONSE_HEADERS");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > maximum) {
    fail("HTTP_RESPONSE_SIZE");
  }
}

function validateResponseHeaders(headers, maximum) {
  if (
    headers["content-encoding"] !== undefined
    && headers["content-encoding"] !== "identity"
  ) {
    fail("HTTP_RESPONSE_ENCODING");
  }
  const contentType = headers["content-type"];
  if (
    typeof contentType !== "string"
    || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)
  ) {
    fail("HTTP_RESPONSE_CONTENT_TYPE");
  }
  parseContentLength(headers["content-length"], maximum);
}

function parseJsonBody(chunks, length) {
  let source;
  try {
    source = new TextDecoder("utf-8", {fatal: true})
      .decode(Buffer.concat(chunks, length));
  } catch {
    fail("HTTP_RESPONSE_BODY");
  }
  if (
    source.length === 0
    || source.includes("\0")
  ) {
    fail("HTTP_RESPONSE_BODY");
  }
  try {
    return JSON.parse(source);
  } catch {
    fail("HTTP_RESPONSE_JSON");
  }
}

export function requestBoundedJson({
  hostname,
  path,
  method = "GET",
  headers = {},
  body = "",
  timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  signal,
  requestProcess = httpsRequest,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
} = {}) {
  const options = validateRequestOptions({
    body,
    headers,
    hostname,
    maxResponseBytes,
    method,
    path,
    signal,
    timeoutMilliseconds,
  });
  if (
    typeof requestProcess !== "function"
    || typeof scheduleTimeout !== "function"
    || typeof cancelTimeout !== "function"
  ) {
    fail("HTTP_OPTIONS");
  }
  if (options.signal?.aborted === true) {
    return Promise.reject(new BoundedJsonHttpError("HTTP_ABORTED"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline;
    let request;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) cancelTimeout(deadline);
      options.signal?.removeEventListener("abort", handleAbort);
      callback(value);
    };
    const rejectCode = (code) => {
      settle(reject, new BoundedJsonHttpError(code));
    };
    const handleAbort = () => {
      if (settled) return;
      rejectCode("HTTP_ABORTED");
      try {
        request?.destroy(new BoundedJsonHttpError("HTTP_ABORTED"));
      } catch {
        // The promise is already rejected with the stable cancellation code.
      }
    };

    try {
      request = requestProcess({
        agent: false,
        headers: {
          ...options.headers,
          ...(options.method === "POST"
            ? {"Content-Length": String(options.bodyBytes)}
            : {}),
        },
        hostname: options.hostname,
        method: options.method,
        path: options.path,
        port: 443,
        protocol: "https:",
      }, (response) => {
        if (settled) {
          response.destroy();
          return;
        }
        try {
          validateResponseHeaders(response.headers, options.maxResponseBytes);
        } catch (error) {
          response.destroy();
          settle(reject, error);
          return;
        }

        const chunks = [];
        let length = 0;
        response.on("data", (chunk) => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          length += bytes.length;
          if (length > options.maxResponseBytes) {
            response.destroy(new BoundedJsonHttpError("HTTP_RESPONSE_SIZE"));
            return;
          }
          chunks.push(bytes);
        });
        response.once("error", (error) => {
          rejectCode(
            error instanceof BoundedJsonHttpError
              ? error.code
              : "HTTP_RESPONSE_STREAM",
          );
        });
        response.once("end", () => {
          if (settled) return;
          try {
            const value = parseJsonBody(chunks, length);
            settle(resolve, Object.freeze({
              statusCode: response.statusCode,
              value,
            }));
          } catch (error) {
            settle(reject, error);
          }
        });
      });
    } catch {
      rejectCode("HTTP_START");
      return;
    }

    options.signal?.addEventListener("abort", handleAbort, {once: true});
    const handleTimeout = () => {
      if (settled) return;
      rejectCode("HTTP_TIMEOUT");
      try {
        request.destroy(new BoundedJsonHttpError("HTTP_TIMEOUT"));
      } catch {
        // The promise is already rejected with the stable deadline code.
      }
    };
    request.setTimeout(options.timeoutMilliseconds, handleTimeout);
    request.once("error", (error) => {
      rejectCode(
        error instanceof BoundedJsonHttpError
          ? error.code
          : "HTTP_TRANSPORT",
      );
    });
    if (options.signal?.aborted === true) {
      handleAbort();
      return;
    }
    try {
      if (!settled) {
        deadline = scheduleTimeout(handleTimeout, options.timeoutMilliseconds);
      }
    } catch {
      rejectCode("HTTP_START");
      try {
        request.destroy();
      } catch {
        // The promise is already rejected with the stable start code.
      }
      return;
    }
    if (options.method === "POST") request.write(options.body, "utf8");
    request.end();
  });
}
