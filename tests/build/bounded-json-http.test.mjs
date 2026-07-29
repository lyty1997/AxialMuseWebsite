import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import test from "node:test";
import {
  BoundedJsonHttpError,
  requestBoundedJson,
} from "../../scripts/deploy/lib/bounded-json-http.mjs";

function createRequestProcess({
  responseBody = "{\"ok\":true}",
  responseHeaders,
  statusCode = 200,
} = {}) {
  const calls = [];
  const requestProcess = (options, callback) => {
    const request = new EventEmitter();
    const call = {body: "", options, timeout: undefined};
    calls.push(call);
    request.setTimeout = (milliseconds, timeout) => {
      call.timeout = {milliseconds, timeout};
    };
    request.write = (chunk) => {
      call.body += chunk;
    };
    request.destroy = (error) => {
      queueMicrotask(() => request.emit("error", error));
    };
    request.end = () => {
      queueMicrotask(() => {
        const response = new PassThrough();
        response.headers = responseHeaders ?? {
          "content-length": String(Buffer.byteLength(responseBody)),
          "content-type": "application/json; charset=utf-8",
        };
        response.statusCode = statusCode;
        callback(response);
        response.end(responseBody);
      });
    };
    return request;
  };
  return {calls, requestProcess};
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => (
    error instanceof BoundedJsonHttpError
    && error.code === code
    && error.stack === undefined
  ));
}

test("#34 bounded HTTPS reader forwards host/path and bounds JSON transport", async () => {
  const {calls, requestProcess} = createRequestProcess();
  const result = await requestBoundedJson({
    body: "{\"request\":true}",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    hostname: "tat.tencentcloudapi.com",
    maxResponseBytes: 1024,
    method: "POST",
    path: "/",
    requestProcess,
    timeoutMilliseconds: 1234,
  });
  assert.deepEqual(result, {statusCode: 200, value: {ok: true}});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.protocol, "https:");
  assert.equal(calls[0].options.hostname, "tat.tencentcloudapi.com");
  assert.equal(calls[0].options.port, 443);
  assert.equal(calls[0].options.agent, false);
  assert.equal(calls[0].options.headers["Content-Length"], "16");
  assert.equal(calls[0].body, "{\"request\":true}");
  assert.equal(calls[0].timeout.milliseconds, 1234);
});

test("#34 bounded HTTPS reader rejects encoded, oversized and malformed responses", async () => {
  {
    const {requestProcess} = createRequestProcess({
      responseHeaders: {
        "content-encoding": "gzip",
        "content-type": "application/json",
      },
    });
    await expectCode(
      requestBoundedJson({
        hostname: "api.github.com",
        path: "/repos/example/example",
        requestProcess,
      }),
      "HTTP_RESPONSE_ENCODING",
    );
  }
  {
    const {requestProcess} = createRequestProcess({
      responseBody: JSON.stringify({value: "x".repeat(128)}),
      responseHeaders: {"content-type": "application/json"},
    });
    await expectCode(
      requestBoundedJson({
        hostname: "api.github.com",
        maxResponseBytes: 32,
        path: "/repos/example/example",
        requestProcess,
      }),
      "HTTP_RESPONSE_SIZE",
    );
  }
  {
    const {requestProcess} = createRequestProcess({
      responseBody: "not-json",
    });
    await expectCode(
      requestBoundedJson({
        hostname: "api.github.com",
        path: "/repos/example/example",
        requestProcess,
      }),
      "HTTP_RESPONSE_JSON",
    );
  }
});

test("#34 bounded HTTPS reader observes cancellation before transport", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await expectCode(
    requestBoundedJson({
      hostname: "api.github.com",
      path: "/repos/example/example",
      requestProcess() {
        calls += 1;
      },
      signal: controller.signal,
    }),
    "HTTP_ABORTED",
  );
  assert.equal(calls, 0);
});

test("#34 bounded HTTPS reader enforces an absolute wall-clock deadline", async () => {
  const request = new EventEmitter();
  let deadlineCallback;
  let deadlineMilliseconds;
  let deadlineToken;
  let clearedToken;
  let destroyed = false;
  request.setTimeout = () => {};
  request.write = () => {};
  request.end = () => {};
  request.destroy = () => {
    destroyed = true;
  };

  const pending = requestBoundedJson({
    cancelTimeout(token) {
      clearedToken = token;
    },
    hostname: "api.github.com",
    path: "/repos/example/example",
    requestProcess() {
      return request;
    },
    scheduleTimeout(callback, milliseconds) {
      deadlineCallback = callback;
      deadlineMilliseconds = milliseconds;
      deadlineToken = Object.freeze({kind: "deadline"});
      return deadlineToken;
    },
    timeoutMilliseconds: 1234,
  });

  assert.equal(typeof deadlineCallback, "function");
  assert.equal(deadlineMilliseconds, 1234);
  deadlineCallback();
  await expectCode(pending, "HTTP_TIMEOUT");
  assert.equal(destroyed, true);
  assert.equal(clearedToken, deadlineToken);
});
