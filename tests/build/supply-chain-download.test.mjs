import assert from "node:assert/strict";
import { globalAgent } from "node:https";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { rootCertificates } from "node:tls";
import {
  downloadRegistryTarball,
  reviewLockedPackageTarballs,
  TARBALL_REVIEW_LIMITS,
} from "../../scripts/quality/lib/supply-chain/tarball-download.mjs";
import { TARBALL_LIMITS } from "../../scripts/quality/lib/supply-chain/tarball.mjs";
import { NpmIsolationError } from "../../scripts/quality/lib/supply-chain/errors.mjs";

function expectCode(action, code) {
  return assert.rejects(action, (error) => error instanceof NpmIsolationError && error.code === code);
}

async function expectCodeWithin(action, code, deadlineMs) {
  let deadlineTimer;
  try {
    await Promise.race([
      expectCode(action, code),
      new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => {
          reject(new Error(`${code} 未在 ${deadlineMs}ms 测试保护期限内返回。`));
        }, deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

function lockedPackage(identity = "alpha@1.2.3") {
  const separator = identity.lastIndexOf("@");
  const name = identity.slice(0, separator);
  const version = identity.slice(separator + 1);
  const tarName = name.includes("/") ? name.split("/")[1] : name;
  return {
    hasInstallScript: false,
    identity,
    integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
    name,
    resolved: `https://registry.npmjs.org/${name}/-/${tarName}-${version}.tgz`,
    version,
  };
}

function response(body, overrides = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    body: Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]),
    headers: { "content-length": String(bytes.length) },
    statusCode: 200,
    url: lockedPackage().resolved,
    ...overrides,
  };
}

test("D-077 official registry tarball downloader", async (suite) => {
  await suite.test("downloads exact bytes without redirect or HTTP content decoding", async () => {
    const expected = Buffer.from("synthetic tarball bytes");
    let requestInput;
    const actual = await downloadRegistryTarball(lockedPackage(), {
      request: async (input) => {
        requestInput = input;
        return response(expected);
      },
    });
    assert.deepEqual(actual, expected);
    assert.equal(requestInput.agent, false);
    assert.equal(requestInput.url.href, lockedPackage().resolved);
    assert.equal(requestInput.timeoutMs, 60_000);
  });

  await suite.test("rejects non-official sources, redirects and encoded responses", async () => {
    const mirror = lockedPackage();
    mirror.resolved = "https://example.test/alpha/-/alpha-1.2.3.tgz";
    await expectCode(
      () => downloadRegistryTarball(mirror, { request: async () => response("x") }),
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_SOURCE",
    );
    const invalidStatus = response("x", { statusCode: 302 });
    await expectCode(
      () => downloadRegistryTarball(lockedPackage(), {
        request: async () => invalidStatus,
      }),
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_RESPONSE",
    );
    assert.equal(invalidStatus.body.destroyed, true);

    const invalidOrigin = response("x", { url: "https://example.test/alpha/-/alpha-1.2.3.tgz" });
    await expectCode(
      () => downloadRegistryTarball(lockedPackage(), {
        request: async () => invalidOrigin,
      }),
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_RESPONSE",
    );
    assert.equal(invalidOrigin.body.destroyed, true);

    const redirect = response("x", { headers: { location: lockedPackage().resolved } });
    await expectCode(
      () => downloadRegistryTarball(lockedPackage(), {
        request: async () => redirect,
      }),
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_REDIRECT",
    );
    assert.equal(redirect.body.destroyed, true);

    const encoded = response("x", { headers: { "content-encoding": "br" } });
    await expectCode(
      () => downloadRegistryTarball(lockedPackage(), {
        request: async () => encoded,
      }),
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_RESPONSE",
    );
    assert.equal(encoded.body.destroyed, true);
  });

  await suite.test("fails closed on response length, byte limits and stream errors", async () => {
    await expectCode(
      () => downloadRegistryTarball(lockedPackage(), {
        request: async () => response("short", { headers: { "content-length": "6" } }),
      }),
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_RESPONSE",
    );
    const invalidDeclaredLength = response("x", {
      headers: { "content-length": String(TARBALL_LIMITS.compressedBytes + 1) },
    });
    await expectCode(
      () => downloadRegistryTarball(lockedPackage(), {
        request: async () => invalidDeclaredLength,
      }),
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_LIMIT",
    );
    assert.equal(invalidDeclaredLength.body.destroyed, true);
    const failedBody = async function* failedBody() {
      yield Buffer.from("x");
      throw new Error("synthetic stream failure");
    };
    await expectCode(
      () => downloadRegistryTarball(lockedPackage(), {
        request: async () => ({
          body: failedBody(),
          headers: {},
          statusCode: 200,
          url: lockedPackage().resolved,
        }),
      }),
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_NETWORK",
    );
  });

  await suite.test("accepts a body that keeps making progress beyond the idle timeout", async () => {
    const body = new PassThrough();
    body.write("a");
    const timers = [
      setTimeout(() => body.write("b"), 400),
      setTimeout(() => body.write("c"), 800),
      setTimeout(() => body.write("d"), 1_200),
      setTimeout(() => body.end("e"), 1_600),
    ];
    try {
      const actual = await downloadRegistryTarball(lockedPackage(), {
        bodyHardTimeoutMs: 2_500,
        request: async () => response(Buffer.alloc(5), {
          body,
          headers: { "content-length": "5" },
        }),
        timeoutMs: 1_000,
      });
      assert.equal(actual.toString("utf8"), "abcde");
    } finally {
      for (const timer of timers) clearTimeout(timer);
      body.destroy();
    }
  });

  await suite.test("fails closed after an idle body or the bounded hard deadline", async () => {
    const idleBody = new PassThrough();
    idleBody.write("a");
    await expectCodeWithin(
      () => downloadRegistryTarball(lockedPackage(), {
        bodyHardTimeoutMs: 2_500,
        request: async () => response(Buffer.alloc(1), { body: idleBody, headers: {} }),
        timeoutMs: 1_000,
      }),
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_TIMEOUT",
      2_000,
    );
    assert.equal(idleBody.destroyed, true);

    const progressingBody = new PassThrough();
    progressingBody.write("a");
    const interval = setInterval(() => progressingBody.write("b"), 300);
    try {
      await expectCodeWithin(
        () => downloadRegistryTarball(lockedPackage(), {
          bodyHardTimeoutMs: 1_200,
          request: async () => response(Buffer.alloc(1), {
            body: progressingBody,
            headers: {},
          }),
          timeoutMs: 1_000,
        }),
        "SUPPLY_CHAIN_TARBALL_DOWNLOAD_TIMEOUT",
        2_000,
      );
      assert.equal(progressingBody.destroyed, true);
    } finally {
      clearInterval(interval);
      progressingBody.destroy();
    }
  });

  await suite.test("does not continue an uncooperative async iterator after timeout", async () => {
    let nextCalls = 0;
    let resolvePending;
    let returnCalls = 0;
    const body = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            nextCalls += 1;
            return new Promise((resolve) => {
              resolvePending = resolve;
            });
          },
          return() {
            returnCalls += 1;
            return Promise.resolve({ done: true });
          },
        };
      },
    };
    await expectCodeWithin(
      () => downloadRegistryTarball(lockedPackage(), {
        bodyHardTimeoutMs: 2_500,
        request: async () => response(Buffer.alloc(1), { body, headers: {} }),
        timeoutMs: 1_000,
      }),
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_TIMEOUT",
      2_000,
    );
    assert.equal(nextCalls, 1);
    assert.equal(returnCalls, 1);
    resolvePending({ done: false, value: Buffer.from("late") });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(nextCalls, 1);
  });

  await suite.test("rejects an empty body chunk without treating it as progress", async () => {
    await expectCode(
      () => downloadRegistryTarball(lockedPackage(), {
        request: async () => response(Buffer.alloc(1), {
          body: Readable.from([Buffer.alloc(0), Buffer.from("x")], {
            objectMode: true,
          }),
          headers: {},
        }),
      }),
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_RESPONSE",
    );
  });

  await suite.test("rejects an unbounded or shorter body hard deadline before requesting", async () => {
    let requests = 0;
    for (const bodyHardTimeoutMs of [999, 1_000.5, 300_001]) {
      await expectCode(
        () => downloadRegistryTarball(lockedPackage(), {
          bodyHardTimeoutMs,
          request: async () => {
            requests += 1;
            return response("unreachable");
          },
          timeoutMs: 1_000,
        }),
        "SUPPLY_CHAIN_TARBALL_DOWNLOAD_INPUT",
      );
    }
    assert.equal(requests, 0);
  });

  await suite.test("preserves the stable validation error when every response terminator throws", async () => {
    let destroys = 0;
    let aborts = 0;
    const body = Readable.from([Buffer.from("x")]);
    body.destroy = (...arguments_) => {
      destroys += 1;
      assert.deepEqual(arguments_, []);
      throw new Error("synthetic destroy failure");
    };
    const invalidResponse = response("x", {
      abort: (...arguments_) => {
        aborts += 1;
        assert.deepEqual(arguments_, []);
        throw new Error("synthetic abort failure");
      },
      body,
      statusCode: 503,
    });

    await expectCode(
      () => downloadRegistryTarball(lockedPackage(), {
        request: async () => invalidResponse,
      }),
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_RESPONSE",
    );
    assert.equal(destroys, 1);
    assert.equal(aborts, 1);
  });

  await suite.test("attempts response abort even when body destroy is a no-op", async () => {
    let aborts = 0;
    let destroys = 0;
    const body = Readable.from([Buffer.from("x")]);
    body.destroy = () => {
      destroys += 1;
      return body;
    };
    const invalidResponse = response("x", {
      abort: () => {
        aborts += 1;
      },
      body,
      statusCode: 503,
    });
    await expectCode(
      () => downloadRegistryTarball(lockedPackage(), {
        request: async () => invalidResponse,
      }),
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_RESPONSE",
    );
    assert.equal(destroys, 1);
    assert.equal(aborts, 1);
  });

  await suite.test("reviews packages in deterministic order and erases downloaded buffers", async () => {
    const downloads = [];
    const inspected = [];
    const validated = [];
    const packages = [lockedPackage("zeta@1.0.0"), lockedPackage("alpha@1.2.3")];
    const result = await reviewLockedPackageTarballs({
      lockedPackages: packages,
      download: async (package_) => {
        const bytes = Buffer.from(package_.identity);
        downloads.push(bytes);
        return bytes;
      },
      inspect: (bytes, package_) => {
        inspected.push(package_.identity);
        return { identity: package_.identity, snapshot: Buffer.from(bytes).toString("utf8") };
      },
      validateInspection: ({ inspection, lockedPackage }) => {
        assert.equal(inspection.identity, lockedPackage.identity);
        validated.push(lockedPackage.identity);
      },
    });
    assert.deepEqual(inspected, ["alpha@1.2.3", "zeta@1.0.0"]);
    assert.deepEqual(validated, inspected);
    assert.deepEqual(result.map(({ identity }) => identity), inspected);
    assert.ok(downloads.every((bytes) => bytes.every((byte) => byte === 0)));
  });

  await suite.test("fails at the first inspection drift and erases its downloaded batch", async () => {
    const downloads = [];
    await expectCode(
      () => reviewLockedPackageTarballs({
        download: async (package_) => {
          const bytes = Buffer.from(package_.identity, "utf8");
          downloads.push(bytes);
          return bytes;
        },
        inspect: (_bytes, package_) => ({ identity: package_.identity }),
        lockedPackages: [lockedPackage("alpha@1.0.0"), lockedPackage("bravo@1.0.0")],
        validateInspection: ({ lockedPackage }) => {
          if (lockedPackage.identity === "alpha@1.0.0") {
            throw new NpmIsolationError("SUPPLY_CHAIN_REVIEW_DRIFT", "synthetic drift");
          }
        },
      }),
      "SUPPLY_CHAIN_REVIEW_DRIFT",
    );
    assert.equal(downloads.length, 2);
    assert.ok(downloads.every((bytes) => bytes.every((byte) => byte === 0)));
  });

  await suite.test("retries timeout and network failures twice before a third-attempt success", async () => {
    for (const code of [
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_TIMEOUT",
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_NETWORK",
    ]) {
      let attempts = 0;
      let downloaded;
      const result = await reviewLockedPackageTarballs({
        download: async () => {
          attempts += 1;
          if (attempts < 3) throw new NpmIsolationError(code, "synthetic transient failure");
          downloaded = Buffer.from("third attempt succeeds", "utf8");
          return downloaded;
        },
        inspect: (_bytes, package_) => ({ identity: package_.identity }),
        lockedPackages: [lockedPackage()],
      });
      assert.equal(attempts, 3);
      assert.deepEqual(result, [{ identity: "alpha@1.2.3" }]);
      assert.ok(downloaded.every((byte) => byte === 0));
    }
  });

  await suite.test("does not retry a non-transient download error", async () => {
    let attempts = 0;
    await expectCode(
      () => reviewLockedPackageTarballs({
        download: async () => {
          attempts += 1;
          throw new NpmIsolationError(
            "SUPPLY_CHAIN_TARBALL_DOWNLOAD_RESPONSE",
            "synthetic permanent failure",
          );
        },
        inspect: () => assert.fail("a failed download must not be inspected"),
        lockedPackages: [lockedPackage()],
      }),
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_RESPONSE",
    );
    assert.equal(attempts, 1);
  });

  await suite.test("fails after the third consecutive transient download error", async () => {
    for (const code of [
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_TIMEOUT",
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_NETWORK",
    ]) {
      let attempts = 0;
      await expectCode(
        () => reviewLockedPackageTarballs({
          download: async () => {
            attempts += 1;
            throw new NpmIsolationError(code, "synthetic persistent transient failure");
          },
          inspect: () => assert.fail("a failed download must not be inspected"),
          lockedPackages: [lockedPackage()],
        }),
        code,
      );
      assert.equal(attempts, 3);
    }
  });

  await suite.test("uses one task-private bounded keep-alive agent in canonical batches", async () => {
    const identities = [
      "alpha@1.0.0",
      "bravo@1.0.0",
      "charlie@1.0.0",
      "delta@1.0.0",
      "echo@1.0.0",
      "foxtrot@1.0.0",
      "golf@1.0.0",
      "hotel@1.0.0",
    ];
    const packages = identities.map((identity) => lockedPackage(identity)).reverse();
    const started = [];
    const inspected = [];
    const gates = new Map();
    const buffers = [];
    let active = 0;
    let maximumActive = 0;
    let taskAgent;
    let destroys = 0;
    const review = reviewLockedPackageTarballs({
      download: async (package_, { agent }) => {
        if (taskAgent === undefined) {
          taskAgent = agent;
          const destroy = agent.destroy.bind(agent);
          agent.destroy = () => {
            destroys += 1;
            assert.equal(active, 0);
            destroy();
          };
        } else {
          assert.equal(agent, taskAgent);
        }
        started.push(package_.identity);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        return new Promise((resolve) => {
          gates.set(package_.identity, () => {
            active -= 1;
            const bytes = Buffer.from(package_.identity, "utf8");
            buffers.push(bytes);
            resolve(bytes);
          });
        });
      },
      inspect: (bytes, package_) => {
        assert.equal(bytes.toString("utf8"), package_.identity);
        inspected.push(package_.identity);
        return { identity: package_.identity };
      },
      lockedPackages: packages,
    });

    assert.deepEqual(started, identities.slice(0, 4));
    assert.notEqual(taskAgent, globalAgent);
    assert.equal(taskAgent.options.ca, rootCertificates);
    assert.equal(taskAgent.options.rejectUnauthorized, true);
    assert.equal(taskAgent.keepAlive, true);
    assert.equal(taskAgent.maxCachedSessions, 0);
    assert.equal(taskAgent.maxFreeSockets, 4);
    assert.equal(taskAgent.maxSockets, 4);
    assert.equal(taskAgent.maxTotalSockets, 4);
    assert.equal(taskAgent.scheduling, "lifo");

    for (const identity of identities.slice(0, 3).reverse()) gates.get(identity)();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, identities.slice(0, 4));
    gates.get(identities[3])();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, identities);
    for (const identity of identities.slice(4).reverse()) gates.get(identity)();

    const result = await review;
    assert.deepEqual(inspected, identities);
    assert.deepEqual(result.map(({ identity }) => identity), identities);
    assert.equal(maximumActive, 4);
    assert.equal(destroys, 1);
    assert.ok(buffers.every((bytes) => bytes.every((byte) => byte === 0)));
  });

  await suite.test("drains a failed canonical batch before cleanup and selects its first error", async () => {
    const identities = ["alpha@1.0.0", "bravo@1.0.0", "charlie@1.0.0", "delta@1.0.0"];
    const gates = new Map();
    const buffers = [];
    let active = 0;
    let destroys = 0;
    let taskAgent;
    const review = reviewLockedPackageTarballs({
      download: async (package_, { agent }) => {
        if (taskAgent === undefined) {
          taskAgent = agent;
          const destroy = agent.destroy.bind(agent);
          agent.destroy = () => {
            destroys += 1;
            assert.equal(active, 0);
            destroy();
          };
        }
        active += 1;
        return new Promise((resolve, reject) => {
          gates.set(package_.identity, {
            fulfill() {
              active -= 1;
              const bytes = Buffer.from(package_.identity, "utf8");
              buffers.push(bytes);
              resolve(bytes);
            },
            reject(error) {
              active -= 1;
              reject(error);
            },
          });
        });
      },
      inspect: () => assert.fail("failed batch must not be inspected"),
      lockedPackages: identities.map((identity) => lockedPackage(identity)),
    });

    gates.get(identities[1]).reject(new NpmIsolationError("SYNTHETIC_BRAVO", "bravo"));
    gates.get(identities[2]).fulfill();
    gates.get(identities[3]).fulfill();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(active, 1);
    assert.equal(destroys, 0);
    gates.get(identities[0]).reject(new NpmIsolationError("SYNTHETIC_ALPHA", "alpha"));

    await expectCode(() => review, "SYNTHETIC_ALPHA");
    assert.equal(destroys, 1);
    assert.ok(buffers.every((bytes) => bytes.every((byte) => byte === 0)));
  });

  await suite.test("does not reuse the private agent between review tasks", async () => {
    const agents = [];
    for (const identity of ["alpha@1.0.0", "bravo@1.0.0"]) {
      await reviewLockedPackageTarballs({
        download: async (_package, { agent }) => {
          agents.push(agent);
          return Buffer.from(identity, "utf8");
        },
        inspect: (_bytes, package_) => ({ identity: package_.identity }),
        lockedPackages: [lockedPackage(identity)],
      });
    }
    assert.equal(agents.length, 2);
    assert.notEqual(agents[0], agents[1]);
  });

  await suite.test("bounds package count and cumulative inspection evidence before retention", async () => {
    let downloads = 0;
    await expectCode(
      () => reviewLockedPackageTarballs({
        lockedPackages: new Array(TARBALL_REVIEW_LIMITS.packages + 1).fill(lockedPackage()),
        download: async () => {
          downloads += 1;
          return Buffer.from("unreachable");
        },
      }),
      "SUPPLY_CHAIN_TARBALL_REVIEW_INPUT",
    );
    assert.equal(downloads, 0);

    for (const maxConcurrentDownloads of [0, 5, 1.5]) {
      await expectCode(
        () => reviewLockedPackageTarballs({
          lockedPackages: [lockedPackage()],
          maxConcurrentDownloads,
          download: async () => {
            downloads += 1;
            return Buffer.from("unreachable");
          },
        }),
        "SUPPLY_CHAIN_TARBALL_REVIEW_INPUT",
      );
    }
    assert.equal(downloads, 0);

    const mirrorAfterValid = lockedPackage("zeta@1.0.0");
    mirrorAfterValid.resolved = "https://example.test/zeta/-/zeta-1.0.0.tgz";
    await expectCode(
      () => reviewLockedPackageTarballs({
        lockedPackages: [lockedPackage("alpha@1.0.0"), mirrorAfterValid],
        download: async () => {
          downloads += 1;
          return Buffer.from("unreachable");
        },
      }),
      "SUPPLY_CHAIN_TARBALL_DOWNLOAD_SOURCE",
    );
    assert.equal(downloads, 0);

    const retainedDownloads = [];
    const packages = [lockedPackage("alpha@1.0.0"), lockedPackage("bravo@1.0.0")];
    const inspection = (package_) => ({
      identity: package_.identity,
      snapshot: "x".repeat(32),
    });
    const oneInspectionBytes = Buffer.byteLength(JSON.stringify(inspection(packages[0])), "utf8");
    await expectCode(
      () => reviewLockedPackageTarballs({
        lockedPackages: packages,
        download: async () => {
          const bytes = Buffer.from("synthetic bytes");
          retainedDownloads.push(bytes);
          return bytes;
        },
        inspect: (_bytes, package_) => inspection(package_),
        maxEvidenceBytes: (oneInspectionBytes * 2) - 1,
      }),
      "SUPPLY_CHAIN_TARBALL_REVIEW_LIMIT",
    );
    assert.equal(retainedDownloads.length, 2);
    assert.ok(retainedDownloads.every((bytes) => bytes.every((byte) => byte === 0)));
  });
});
