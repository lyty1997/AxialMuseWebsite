import assert from "node:assert/strict";
import {spawn, spawnSync, type ChildProcess} from "node:child_process";
import {createHash} from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import {createServer, type Server} from "node:http";
import {tmpdir} from "node:os";
import {
  dirname,
  delimiter,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const BROWSER_NAMES = Object.freeze([
  ...(process.platform === "win32"
    ? ["chrome.exe"]
    : [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
    ]),
]);
const BROWSER_PROFILE_PREFIX = "axial-muse-browser-profile-";
const COMMAND_TIMEOUT_MS = 15_000;
const STARTUP_TIMEOUT_MS = 20_000;
const NETWORK_IDLE_TIMEOUT_MS = 10_000;
const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
});

type JsonRecord = Record<string, unknown>;

interface PendingCommand {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: JsonRecord) => void;
  readonly timer: NodeJS.Timeout;
}

interface BrowserObservation {
  consoleErrors: string[];
  failedRequests: string[];
  inFlightRequests: Map<string, string>;
  responseErrors: string[];
  unexpectedRequests: string[];
}

interface ElementRectangle {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

interface DetailSnapshot {
  readonly articleRect: ElementRectangle;
  readonly desktopDirectoryRect?: ElementRectangle;
  readonly desktopDirectoryVisible: boolean;
  readonly desktopTocRect?: ElementRectangle;
  readonly desktopTocVisible: boolean;
  readonly innerWidth: number;
  readonly labelsHaveZeroLetterSpacing: boolean;
  readonly leftDetailsAboveArticle: boolean;
  readonly leftDetailsClosed: boolean;
  readonly leftDetailsVisible: boolean;
  readonly mobileTocAboveMarkdown: boolean;
  readonly mobileTocClosed: boolean;
  readonly mobileTocVisible: boolean;
  readonly pageOverflows: boolean;
  readonly toggleVisible: boolean;
  readonly visibleNavbarItems: number;
}

interface FixedViewportReceipt {
  readonly height: number;
  readonly route: string;
  readonly screenshotBytes: number;
  readonly screenshotSha256: string;
  readonly width: number;
}

interface DevToolsEndpoint {
  readonly browserWebSocketUrl: string;
  readonly httpOrigin: string;
}

export interface ThemeBrowserRegressionReceipt {
  readonly browserProduct: string;
  readonly fixedViewports: readonly FixedViewportReceipt[];
  readonly probes: readonly string[];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeBrowserProduct(value: unknown): string {
  if (typeof value !== "string") {
    assert.fail("浏览器产品版本缺失");
  }
  assert.match(value, /^(?:Chrome|Chromium|HeadlessChrome)\/[0-9.]+$/u);
  return value;
}

function sanitizeExternalUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}/<redacted>`;
  } catch {
    return "invalid-url";
  }
}

function sanitizeBrowserDiagnostic(value: string, origin: string): string {
  return value
    .replaceAll(origin, "<fixture>")
    .replace(/https?:\/\/[^\s"'<>]+/gu, (url) => sanitizeExternalUrl(url))
    .replace(/file:\/\/\/[^\s"'<>]+/gu, "file:///<redacted>")
    .slice(0, 500);
}

function executableFromPath(name: string): string | undefined {
  const pathValue = process.env.PATH;
  if (pathValue === undefined) return undefined;
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0 || !isAbsolute(directory)) continue;
    const candidate = resolve(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      const metadata = statSync(candidate);
      if (!metadata.isFile()) continue;
      const canonicalCandidate = realpathSync(candidate);
      if (process.platform === "win32") return canonicalCandidate;
      const version = spawnSync(canonicalCandidate, ["--version"], {
        encoding: "utf8",
        env: {
          LANG: process.env.LANG ?? "C.UTF-8",
          PATH: process.env.PATH,
        },
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: COMMAND_TIMEOUT_MS,
      });
      assert.equal(
        version.status,
        0,
        "[BROWSER_VERSION] Chromium 版本探针失败",
      );
      assert.match(
        version.stdout,
        /(?:Google Chrome|Chromium)[ /][0-9.]+/u,
        "[BROWSER_VERSION] 浏览器产品不属于 Chromium",
      );
      return canonicalCandidate;
    } catch {
      // 继续检查下一个受控 PATH 候选。
    }
  }
  return undefined;
}

function resolveBrowserExecutable(): string {
  for (const name of BROWSER_NAMES) {
    const candidate = executableFromPath(name);
    if (candidate === undefined) continue;
    return candidate;
  }
  assert.fail(
    `[BROWSER_UNAVAILABLE] PATH 中缺少 ${BROWSER_NAMES.join("、")}`,
  );
}

function contentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

async function startStaticServer(buildRoot: string): Promise<Readonly<{
  close: () => Promise<void>;
  origin: string;
}>> {
  const canonicalBuildRoot = realpathSync(buildRoot);
  assert.equal(
    lstatSync(canonicalBuildRoot).isDirectory(),
    true,
    "浏览器回归 buildRoot 必须是普通目录",
  );
  let origin = "";
  const serverErrors: Error[] = [];
  const server = createServer((request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, {"content-length": "0"});
        response.end();
        return;
      }
      if (origin.length > 0 && request.headers.host !== new URL(origin).host) {
        response.writeHead(400, {"content-length": "0"});
        response.end();
        return;
      }
      const requestUrl = new URL(request.url ?? "/", origin || "http://127.0.0.1");
      const decodedPath = decodeURIComponent(requestUrl.pathname);
      if (
        decodedPath.includes("\0")
        || decodedPath.includes("\\")
        || decodedPath.split("/").includes("..")
      ) {
        response.writeHead(400, {"content-length": "0"});
        response.end();
        return;
      }
      let target = resolve(
        canonicalBuildRoot,
        `.${decodedPath.endsWith("/") ? `${decodedPath}index.html` : decodedPath}`,
      );
      const relativeTarget = relative(canonicalBuildRoot, target);
      if (
        relativeTarget === ".."
        || relativeTarget.startsWith(`..${sep}`)
        || isAbsolute(relativeTarget)
      ) {
        response.writeHead(400, {"content-length": "0"});
        response.end();
        return;
      }
      if (existsSync(target) && statSync(target).isDirectory()) {
        target = resolve(target, "index.html");
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        response.writeHead(404, {"content-length": "0"});
        response.end();
        return;
      }
      const bytes = readFileSync(target);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": String(bytes.byteLength),
        "content-type": contentType(target),
      });
      if (request.method === "HEAD") {
        response.end();
      } else {
        response.end(bytes);
      }
    } catch (error) {
      serverErrors.push(
        error instanceof Error ? error : new Error("静态服务器发生未知错误"),
      );
      response.writeHead(500, {"content-length": "0"});
      response.end();
    }
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  return Object.freeze({
    origin,
    async close() {
      await closeServer(server);
      assert.deepEqual(serverErrors, [], "浏览器回归静态服务器发生错误");
    },
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error === undefined) resolvePromise();
      else rejectPromise(error);
    });
  });
}

class DevToolsConnection {
  private readonly eventHandlers = new Map<
    string,
    Set<(parameters: JsonRecord) => void>
  >();
  private readonly pending = new Map<number, PendingCommand>();
  private readonly socket: WebSocket;
  private nextId = 1;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      this.rejectPending(new Error("[BROWSER_DISCONNECTED] Chromium 调试连接提前关闭"));
    });
    socket.addEventListener("error", () => {
      this.rejectPending(new Error("[BROWSER_PROTOCOL] Chromium 调试连接发生错误"));
    });
  }

  static async connect(url: string): Promise<DevToolsConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        rejectPromise(new Error("[BROWSER_TIMEOUT] Chromium 调试连接超时"));
      }, COMMAND_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolvePromise();
      }, {once: true});
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectPromise(new Error("[BROWSER_PROTOCOL] 无法建立 Chromium 调试连接"));
      }, {once: true});
    });
    return new DevToolsConnection(socket);
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }

  on(method: string, handler: (parameters: JsonRecord) => void): () => void {
    const handlers = this.eventHandlers.get(method) ?? new Set();
    handlers.add(handler);
    this.eventHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
    };
  }

  send(method: string, parameters: JsonRecord = {}): Promise<JsonRecord> {
    assert.equal(
      this.socket.readyState,
      WebSocket.OPEN,
      "[BROWSER_DISCONNECTED] Chromium 调试连接不可用",
    );
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<JsonRecord>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`[BROWSER_TIMEOUT] Chromium 命令超时：${method}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, {
        reject: rejectPromise,
        resolve: resolvePromise,
        timer,
      });
      this.socket.send(JSON.stringify({id, method, params: parameters}));
    });
  }

  waitForEvent(method: string): Promise<JsonRecord> {
    return new Promise<JsonRecord>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        dispose();
        rejectPromise(new Error(`[BROWSER_TIMEOUT] Chromium 事件超时：${method}`));
      }, COMMAND_TIMEOUT_MS);
      const dispose = this.on(method, (parameters) => {
        clearTimeout(timer);
        dispose();
        resolvePromise(parameters);
      });
    });
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.rejectPending(new Error("[BROWSER_PROTOCOL] Chromium 返回了非法 JSON"));
      return;
    }
    if (!isJsonRecord(message)) return;
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (isJsonRecord(message.error)) {
        pending.reject(new Error("[BROWSER_PROTOCOL] Chromium 命令返回错误"));
      } else {
        pending.resolve(isJsonRecord(message.result) ? message.result : {});
      }
      return;
    }
    if (typeof message.method !== "string") return;
    const parameters = isJsonRecord(message.params) ? message.params : {};
    for (const handler of this.eventHandlers.get(message.method) ?? []) {
      handler(parameters);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function waitForDevTools(
  profileRoot: string,
  browserProcess: ChildProcess,
): Promise<DevToolsEndpoint> {
  const activePortPath = resolve(profileRoot, "DevToolsActivePort");
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (browserProcess.exitCode !== null || browserProcess.signalCode !== null) {
      throw new Error("[BROWSER_START] Chromium 在调试端口就绪前退出");
    }
    if (existsSync(activePortPath)) {
      const lines = readFileSync(activePortPath, "utf8").trim().split(/\r?\n/u);
      if (/^[1-9][0-9]{1,4}$/u.test(lines[0] ?? "") && lines[1]?.startsWith("/")) {
        return Object.freeze({
          browserWebSocketUrl: `ws://127.0.0.1:${lines[0]}${lines[1]}`,
          httpOrigin: `http://127.0.0.1:${lines[0]}`,
        });
      }
    }
    await delay(25);
  }
  throw new Error("[BROWSER_TIMEOUT] Chromium 调试端口启动超时");
}

async function resolvePageWebSocketUrl(
  endpoint: DevToolsEndpoint,
): Promise<string> {
  const response = await fetch(`${endpoint.httpOrigin}/json/list`);
  assert.equal(response.status, 200, "[BROWSER_PROTOCOL] 无法读取 Chromium 页面目标");
  const targets: unknown = await response.json();
  assert.ok(Array.isArray(targets), "[BROWSER_PROTOCOL] Chromium 页面目标格式非法");
  const pageTarget = targets.find((target) => (
    isJsonRecord(target)
    && target.type === "page"
    && target.url === "about:blank"
    && typeof target.webSocketDebuggerUrl === "string"
  ));
  assert.ok(
    isJsonRecord(pageTarget)
      && typeof pageTarget.webSocketDebuggerUrl === "string",
    "[BROWSER_PROTOCOL] Chromium 缺少受控 about:blank 页面目标",
  );
  const pageWebSocketUrl = new URL(pageTarget.webSocketDebuggerUrl);
  const endpointOrigin = new URL(endpoint.httpOrigin);
  assert.equal(pageWebSocketUrl.protocol, "ws:");
  assert.equal(pageWebSocketUrl.hostname, endpointOrigin.hostname);
  assert.equal(pageWebSocketUrl.port, endpointOrigin.port);
  return pageWebSocketUrl.href;
}

function startBrowser(browserExecutable: string, profileRoot: string): ChildProcess {
  const child = spawn(browserExecutable, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-domain-reliability",
    "--disable-features=MediaRouter,OptimizationHints,Translate",
    "--disable-gpu",
    "--disable-sync",
    "--force-color-profile=srgb",
    "--lang=zh-CN",
    "--metrics-recording-only",
    "--no-default-browser-check",
    "--no-first-run",
    "--no-pings",
    "--password-store=basic",
    "--remote-allow-origins=*",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileRoot}`,
    "--use-mock-keychain",
    "about:blank",
  ], {
    env: {
      HOME: process.env.HOME,
      LANG: process.env.LANG ?? "C.UTF-8",
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  return child;
}

function createObservation(
  connection: DevToolsConnection,
  origin: string,
): BrowserObservation {
  const observation: BrowserObservation = {
    consoleErrors: [],
    failedRequests: [],
    inFlightRequests: new Map(),
    responseErrors: [],
    unexpectedRequests: [],
  };
  connection.on("Runtime.consoleAPICalled", (parameters) => {
    if (parameters.type === "error" || parameters.type === "assert") {
      const argumentsValue = Array.isArray(parameters.args)
        ? parameters.args
          .map((argument) => {
            if (!isJsonRecord(argument)) return undefined;
            if (
              typeof argument.value === "string"
              || typeof argument.value === "number"
              || typeof argument.value === "boolean"
            ) {
              return String(argument.value);
            }
            return typeof argument.description === "string"
              ? argument.description
              : undefined;
          })
          .filter((value): value is string => value !== undefined)
          .join(" ")
        : "";
      observation.consoleErrors.push(
        sanitizeBrowserDiagnostic(
          `${String(parameters.type)}: ${argumentsValue}`,
          origin,
        ),
      );
    }
  });
  connection.on("Runtime.exceptionThrown", () => {
    observation.consoleErrors.push("exception");
  });
  connection.on("Log.entryAdded", (parameters) => {
    const entry = isJsonRecord(parameters.entry) ? parameters.entry : {};
    if (entry.level === "error" || entry.level === "warning") {
      const text = typeof entry.text === "string" ? entry.text : "";
      const source = typeof entry.url === "string"
        ? entry.url.replace(origin, "<fixture>")
        : "";
      observation.consoleErrors.push(
        sanitizeBrowserDiagnostic(
          `${String(entry.level)}: ${text} ${source}`.trim(),
          origin,
        ),
      );
    }
  });
  connection.on("Network.requestWillBeSent", (parameters) => {
    const requestId = parameters.requestId;
    const request = isJsonRecord(parameters.request) ? parameters.request : {};
    if (typeof request.url !== "string") return;
    if (
      request.url.startsWith("about:")
      || request.url.startsWith("blob:")
      || request.url.startsWith("data:")
    ) return;
    if (typeof requestId === "string") {
      observation.inFlightRequests.set(
        requestId,
        request.url.replaceAll(origin, "<fixture>").slice(0, 500),
      );
    }
    try {
      const parsedUrl = new URL(request.url);
      if (parsedUrl.origin !== origin) {
        observation.unexpectedRequests.push(sanitizeExternalUrl(request.url));
      }
    } catch {
      observation.unexpectedRequests.push("invalid-url");
    }
  });
  connection.on("Network.loadingFinished", (parameters) => {
    if (typeof parameters.requestId === "string") {
      observation.inFlightRequests.delete(parameters.requestId);
    }
  });
  connection.on("Network.requestServedFromCache", (parameters) => {
    if (typeof parameters.requestId === "string") {
      observation.inFlightRequests.delete(parameters.requestId);
    }
  });
  connection.on("Network.loadingFailed", (parameters) => {
    const requestUrl = typeof parameters.requestId === "string"
      ? observation.inFlightRequests.get(parameters.requestId) ?? "unknown"
      : "unknown";
    if (typeof parameters.requestId === "string") {
      observation.inFlightRequests.delete(parameters.requestId);
    }
    const failureReason = (
      typeof parameters.errorText === "string"
      && parameters.errorText.length > 0
    )
      ? parameters.errorText
      : typeof parameters.blockedReason === "string"
        ? `blocked:${parameters.blockedReason}`
        : "unknown";
    observation.failedRequests.push(`${requestUrl}:${failureReason}`);
  });
  connection.on("Network.responseReceived", (parameters) => {
    if (typeof parameters.requestId === "string") {
      observation.inFlightRequests.delete(parameters.requestId);
    }
    const response = isJsonRecord(parameters.response) ? parameters.response : {};
    if (typeof response.status === "number" && response.status >= 400) {
      const url = typeof response.url === "string"
        ? sanitizeBrowserDiagnostic(response.url, origin)
        : "unknown";
      observation.responseErrors.push(`${String(response.status)}:${url}`);
    }
  });
  return observation;
}

function resetObservation(observation: BrowserObservation): void {
  observation.consoleErrors.length = 0;
  observation.failedRequests.length = 0;
  observation.inFlightRequests.clear();
  observation.responseErrors.length = 0;
  observation.unexpectedRequests.length = 0;
}

async function waitForNetworkIdle(observation: BrowserObservation): Promise<void> {
  const deadline = Date.now() + NETWORK_IDLE_TIMEOUT_MS;
  let stableSince: number | undefined;
  while (Date.now() < deadline) {
    if (observation.inFlightRequests.size === 0) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= 100) return;
    } else {
      stableSince = undefined;
    }
    await delay(20);
  }
  assert.fail(
    `[BROWSER_NETWORK_IDLE] 页面请求未在期限内稳定结束：${
      JSON.stringify([...observation.inFlightRequests.values()])
    }`,
  );
}

async function waitForHydration(connection: DevToolsConnection): Promise<void> {
  const deadline = Date.now() + COMMAND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (
      await evaluate<boolean>(
        connection,
        'document.documentElement.dataset.hasHydrated === "true"',
      )
    ) {
      return;
    }
    await delay(20);
  }
  assert.fail("[BROWSER_HYDRATION] Docusaurus 未在期限内完成 hydration");
}

function assertObservationClean(observation: BrowserObservation): void {
  assert.deepEqual(observation.consoleErrors, [], "浏览器 console 出现错误或警告");
  assert.deepEqual(observation.failedRequests, [], "浏览器存在失败请求");
  assert.deepEqual(observation.responseErrors, [], "浏览器存在 HTTP 错误响应");
  assert.deepEqual(observation.unexpectedRequests, [], "浏览器发起了非本站请求");
}

function assertExpectedLocalFailures(
  observation: BrowserObservation,
  resourcePattern: RegExp,
  errorPattern: RegExp,
): void {
  assert.ok(observation.failedRequests.length > 0, "预期资源失败没有发生");
  for (const failure of observation.failedRequests) {
    assert.match(failure, /^<fixture>\//u);
    assert.match(failure, resourcePattern);
    assert.match(failure, errorPattern);
  }
  for (const message of observation.consoleErrors) {
    assert.match(message, /(?:Failed to load resource|ERR_)/u);
  }
  assert.deepEqual(observation.inFlightRequests, new Map());
  assert.deepEqual(observation.responseErrors, [], "预期失败不得产生 HTTP 错误响应");
  assert.deepEqual(observation.unexpectedRequests, [], "预期失败不得发起非本站请求");
}

async function evaluate<T>(
  connection: DevToolsConnection,
  expression: string,
): Promise<T> {
  const response = await connection.send("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
  assert.equal(response.exceptionDetails, undefined, "浏览器页面表达式执行失败");
  const result = isJsonRecord(response.result) ? response.result : {};
  return result.value as T;
}

async function isolatePage(connection: DevToolsConnection): Promise<void> {
  const currentUrl = await evaluate<string>(connection, "location.href");
  if (currentUrl === "about:blank") return;
  const blankLoaded = connection.waitForEvent("Page.loadEventFired");
  const blankResult = await connection.send("Page.navigate", {
    url: "about:blank",
  });
  assert.equal(blankResult.errorText, undefined, "浏览器隔离导航失败");
  await blankLoaded;
  await delay(50);
}

async function setViewport(
  connection: DevToolsConnection,
  width: number,
  height: number,
  reducedMotion: boolean,
): Promise<void> {
  await connection.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height,
    mobile: false,
    width,
  });
  await connection.send("Emulation.setEmulatedMedia", {
    features: [{
      name: "prefers-reduced-motion",
      value: reducedMotion ? "reduce" : "no-preference",
    }],
    media: "screen",
  });
}

async function navigate(
  connection: DevToolsConnection,
  observation: BrowserObservation,
  url: string,
  width: number,
  height: number,
  reducedMotion = false,
  requireHydration = true,
): Promise<void> {
  await isolatePage(connection);
  await setViewport(connection, width, height, reducedMotion);
  resetObservation(observation);
  const loaded = connection.waitForEvent("Page.loadEventFired");
  const result = await connection.send("Page.navigate", {url});
  assert.equal(result.errorText, undefined, "浏览器导航失败");
  await loaded;
  await waitForNetworkIdle(observation);
  await evaluate(connection, `new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`);
  if (requireHydration) await waitForHydration(connection);
  assert.equal(
    await evaluate(connection, "document.readyState"),
    "complete",
    "浏览器页面未完成加载",
  );
}

const DETAIL_SNAPSHOT_EXPRESSION = `(() => {
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && rect.width > 0
      && rect.height > 0;
  };
  const rect = (element) => {
    const value = element.getBoundingClientRect();
    return {
      bottom: value.bottom,
      left: value.left,
      right: value.right,
      top: value.top,
    };
  };
  const detailsByLabel = (label) => [...document.querySelectorAll("details")]
    .find((element) => element.querySelector(":scope > summary")?.textContent?.trim() === label);
  const leftDetails = detailsByLabel("浏览本栏目");
  const mobileToc = detailsByLabel("本页目录");
  const desktopDirectory = document.querySelector("aside.theme-doc-sidebar-container");
  const desktopToc = document.querySelector('aside[aria-label="本页目录"]');
  const article = document.querySelector("article");
  const markdown = document.querySelector(".theme-doc-markdown");
  const navbarToggle = document.querySelector(".navbar__toggle");
  const labels = [
    document.querySelector("h1"),
    leftDetails?.querySelector("summary"),
    mobileToc?.querySelector("summary"),
    desktopDirectory?.querySelector("p"),
    desktopToc?.querySelector("p"),
  ].filter(Boolean);
  const articleRect = rect(article);
  const leftRect = leftDetails ? rect(leftDetails) : undefined;
  const mobileTocRect = mobileToc ? rect(mobileToc) : undefined;
  const markdownRect = markdown ? rect(markdown) : undefined;
  return {
    articleRect,
    desktopDirectoryRect: desktopDirectory ? rect(desktopDirectory) : undefined,
    desktopDirectoryVisible: isVisible(desktopDirectory),
    desktopTocRect: desktopToc ? rect(desktopToc) : undefined,
    desktopTocVisible: isVisible(desktopToc),
    innerWidth,
    labelsHaveZeroLetterSpacing: labels.every((element) => {
      const value = getComputedStyle(element).letterSpacing;
      return value === "normal" || value === "0px";
    }),
    leftDetailsAboveArticle: leftRect === undefined || leftRect.bottom <= articleRect.top + 0.5,
    leftDetailsClosed: leftDetails?.open === false,
    leftDetailsVisible: isVisible(leftDetails),
    mobileTocAboveMarkdown: mobileTocRect === undefined
      || markdownRect === undefined
      || mobileTocRect.bottom <= markdownRect.top + 0.5,
    mobileTocClosed: mobileToc?.open === false,
    mobileTocVisible: isVisible(mobileToc),
    pageOverflows: document.documentElement.scrollWidth
      > document.documentElement.clientWidth + 1
      || document.body.scrollWidth > document.body.clientWidth + 1,
    toggleVisible: isVisible(navbarToggle),
    visibleNavbarItems: [...document.querySelectorAll(".navbar__item")]
      .filter(isVisible).length,
  };
})()`;

const PROJECT_IMAGE_LAYOUT_EXPRESSION = `(() => {
  const image = document.querySelector("main img");
  const title = document.querySelector("main article h2");
  const imageRect = image.getBoundingClientRect();
  const titleRect = title.getBoundingClientRect();
  return {
    complete: image.complete,
    heightAttribute: image.getAttribute("height") ?? "",
    imageBottom: imageRect.bottom,
    imageHeight: imageRect.height,
    imageTop: imageRect.top,
    imageWidth: imageRect.width,
    naturalWidth: image.naturalWidth,
    pageOverflows: document.documentElement.scrollWidth
      > document.documentElement.clientWidth + 1
      || document.body.scrollWidth > document.body.clientWidth + 1,
    titleTop: titleRect.top,
    widthAttribute: image.getAttribute("width") ?? "",
  };
})()`;

interface ProjectImageLayoutSnapshot {
  readonly complete: boolean;
  readonly heightAttribute: string;
  readonly imageBottom: number;
  readonly imageHeight: number;
  readonly imageTop: number;
  readonly imageWidth: number;
  readonly naturalWidth: number;
  readonly pageOverflows: boolean;
  readonly titleTop: number;
  readonly widthAttribute: string;
}

function rectanglesOverlap(
  left: ElementRectangle,
  right: ElementRectangle,
): boolean {
  return (
    left.left < right.right - 0.5
    && left.right > right.left + 0.5
    && left.top < right.bottom - 0.5
    && left.bottom > right.top + 0.5
  );
}

function assertDetailSnapshot(snapshot: DetailSnapshot, width: number): void {
  assert.equal(snapshot.innerWidth, width, "浏览器 CSS viewport 宽度漂移");
  assert.equal(snapshot.pageOverflows, false, `${width}px 页面发生横向溢出`);
  assert.equal(
    snapshot.labelsHaveZeroLetterSpacing,
    true,
    `${width}px 出现非零 letter-spacing`,
  );
  assert.equal(snapshot.leftDetailsClosed, true, "浏览本栏目必须默认收起");
  assert.equal(snapshot.leftDetailsAboveArticle, true, "浏览本栏目必须位于正文上方");
  if (width >= 1280) {
    assert.equal(snapshot.desktopDirectoryVisible, true);
    assert.equal(snapshot.leftDetailsVisible, false);
  } else {
    assert.equal(snapshot.desktopDirectoryVisible, false);
    assert.equal(snapshot.leftDetailsVisible, true);
  }
  if (width >= 996) {
    assert.equal(snapshot.desktopTocVisible, true);
    assert.equal(snapshot.mobileTocVisible, false);
    assert.equal(snapshot.toggleVisible, false);
    assert.ok(snapshot.visibleNavbarItems >= 5, `${width}px 桌面导航项缺失`);
  } else {
    assert.equal(snapshot.desktopTocVisible, false);
    assert.equal(snapshot.mobileTocVisible, true);
    assert.equal(snapshot.mobileTocClosed, true);
    assert.equal(snapshot.mobileTocAboveMarkdown, true);
    assert.equal(snapshot.toggleVisible, true);
    assert.equal(snapshot.visibleNavbarItems, 0);
  }
  if (snapshot.desktopTocVisible) {
    assert.ok(snapshot.desktopTocRect !== undefined);
    assert.equal(
      rectanglesOverlap(snapshot.articleRect, snapshot.desktopTocRect),
      false,
      `${width}px 正文与右侧目录重叠`,
    );
  }
  if (snapshot.desktopDirectoryVisible) {
    assert.ok(snapshot.desktopDirectoryRect !== undefined);
    assert.equal(
      rectanglesOverlap(snapshot.articleRect, snapshot.desktopDirectoryRect),
      false,
      `${width}px 正文与左侧目录重叠`,
    );
  }
}

async function captureScreenshot(
  connection: DevToolsConnection,
): Promise<Readonly<{bytes: number; sha256: string}>> {
  const response = await connection.send("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png",
    fromSurface: true,
  });
  if (typeof response.data !== "string") {
    assert.fail("浏览器截图字节缺失");
  }
  const bytes = Buffer.from(response.data, "base64");
  assert.ok(bytes.byteLength > 1_000, "浏览器截图字节异常");
  return Object.freeze({
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

async function dispatchEnter(connection: DevToolsConnection): Promise<void> {
  await connection.send("Input.dispatchKeyEvent", {
    code: "Enter",
    key: "Enter",
    nativeVirtualKeyCode: 13,
    text: "\r",
    type: "keyDown",
    unmodifiedText: "\r",
    windowsVirtualKeyCode: 13,
  });
  await connection.send("Input.dispatchKeyEvent", {
    code: "Enter",
    key: "Enter",
    nativeVirtualKeyCode: 13,
    type: "keyUp",
    windowsVirtualKeyCode: 13,
  });
  await evaluate(connection, `new Promise((resolve) => requestAnimationFrame(resolve))`);
}

async function dispatchEscape(connection: DevToolsConnection): Promise<void> {
  await connection.send("Input.dispatchKeyEvent", {
    code: "Escape",
    key: "Escape",
    nativeVirtualKeyCode: 27,
    type: "keyDown",
    windowsVirtualKeyCode: 27,
  });
  await connection.send("Input.dispatchKeyEvent", {
    code: "Escape",
    key: "Escape",
    nativeVirtualKeyCode: 27,
    type: "keyUp",
    windowsVirtualKeyCode: 27,
  });
  await evaluate(connection, `new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`);
}

async function probeDelayedFailedProjectImage(
  connection: DevToolsConnection,
  observation: BrowserObservation,
  url: string,
  origin: string,
): Promise<void> {
  await isolatePage(connection);
  await setViewport(connection, 1440, 900, false);
  resetObservation(observation);
  let pausedRequestId: string | undefined;
  let requestReleased = false;
  await connection.send("Fetch.enable", {
    patterns: [{
      requestStage: "Request",
      urlPattern: "*.webp",
    }],
  });
  try {
    const paused = connection.waitForEvent("Fetch.requestPaused");
    const domContentLoaded = connection.waitForEvent("Page.domContentEventFired");
    const loaded = connection.waitForEvent("Page.loadEventFired");
    const result = await connection.send("Page.navigate", {url});
    assert.equal(result.errorText, undefined, "图片延迟探针导航失败");
    const pausedRequest = await paused;
    const request = isJsonRecord(pausedRequest.request)
      ? pausedRequest.request
      : {};
    if (typeof pausedRequest.requestId !== "string") {
      assert.fail("图片延迟探针缺少 Fetch requestId");
    }
    pausedRequestId = pausedRequest.requestId;
    if (typeof request.url !== "string") {
      assert.fail("图片延迟探针缺少资源 URL");
    }
    const requestUrl = new URL(request.url);
    assert.equal(requestUrl.origin, origin);
    assert.match(requestUrl.pathname, /\.webp$/u);
    await domContentLoaded;
    await waitForHydration(connection);
    await evaluate(connection, `new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`);
    const delayed = await evaluate<ProjectImageLayoutSnapshot>(
      connection,
      PROJECT_IMAGE_LAYOUT_EXPRESSION,
    );
    assert.equal(delayed.complete, false, "延迟图片在放行前不应完成");
    assert.equal(delayed.naturalWidth, 0);
    assert.equal(delayed.widthAttribute, "1600");
    assert.equal(delayed.heightAttribute, "1000");
    assert.ok(delayed.imageWidth > 100);
    assert.ok(Math.abs((delayed.imageWidth / delayed.imageHeight) - 1.6) < 0.01);
    assert.ok(delayed.titleTop >= delayed.imageBottom);
    assert.equal(delayed.pageOverflows, false);

    await connection.send("Fetch.failRequest", {
      errorReason: "Failed",
      requestId: pausedRequestId,
    });
    requestReleased = true;
    await loaded;
    await waitForNetworkIdle(observation);
    await evaluate(connection, `new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`);
    const failed = await evaluate<ProjectImageLayoutSnapshot>(
      connection,
      PROJECT_IMAGE_LAYOUT_EXPRESSION,
    );
    assert.equal(failed.complete, true, "失败图片应进入稳定完成状态");
    assert.equal(failed.naturalWidth, 0);
    assert.equal(failed.widthAttribute, "1600");
    assert.equal(failed.heightAttribute, "1000");
    assert.equal(failed.pageOverflows, false);
    assert.ok(Math.abs(failed.imageTop - delayed.imageTop) <= 0.5);
    assert.ok(Math.abs(failed.imageHeight - delayed.imageHeight) <= 0.5);
    assert.ok(Math.abs(failed.titleTop - delayed.titleTop) <= 0.5);
    assertExpectedLocalFailures(
      observation,
      /\.webp:/u,
      /ERR_FAILED/u,
    );
  } finally {
    if (pausedRequestId !== undefined && !requestReleased) {
      try {
        await connection.send("Fetch.failRequest", {
          errorReason: "Failed",
          requestId: pausedRequestId,
        });
      } catch {
        // Fetch.disable 和浏览器清理仍会收口未完成导航。
      }
    }
    await connection.send("Fetch.disable");
  }
}

async function probeNoHydrationStaticContent(
  connection: DevToolsConnection,
  observation: BrowserObservation,
  origin: string,
  detailRoute: string,
): Promise<void> {
  await connection.send("Network.setBlockedURLs", {urls: ["*.js"]});
  try {
    await navigate(
      connection,
      observation,
      `${origin}/`,
      360,
      800,
      false,
      false,
    );
    const home = await evaluate<Readonly<{
      actionHref: string;
      actionVisible: boolean;
      h1: string;
      h1Visible: boolean;
      hasHydrated: boolean;
      pageOverflows: boolean;
    }>>(connection, `(() => {
      const h1 = document.querySelector("h1");
      const action = [...document.querySelectorAll("main a")].find(
        (element) => element.textContent?.trim() === "浏览项目",
      );
      return {
        actionHref: action?.getAttribute("href") ?? "",
        actionVisible: (action?.getBoundingClientRect().height ?? 0) > 0,
        h1: h1?.textContent?.trim() ?? "",
        h1Visible: (h1?.getBoundingClientRect().height ?? 0) > 0,
        hasHydrated: document.documentElement.dataset.hasHydrated === "true",
        pageOverflows: document.documentElement.scrollWidth
          > document.documentElement.clientWidth + 1
          || document.body.scrollWidth > document.body.clientWidth + 1,
      };
    })()`);
    assert.deepEqual(home, {
      actionHref: "/projects/",
      actionVisible: true,
      h1: "Axial Muse",
      h1Visible: true,
      hasHydrated: false,
      pageOverflows: false,
    });
    assertExpectedLocalFailures(
      observation,
      /\.js:/u,
      /(?:ERR_BLOCKED_BY_(?:CLIENT|INSPECTOR)|blocked:inspector)/u,
    );

    await navigate(
      connection,
      observation,
      `${origin}${detailRoute}`,
      360,
      800,
      false,
      false,
    );
    const detail = await evaluate<Readonly<{
      articleVisible: boolean;
      hasHydrated: boolean;
      nativeDetailsClosed: boolean;
      nativeDetailsVisible: boolean;
      pageOverflows: boolean;
    }>>(connection, `(() => {
      const details = [...document.querySelectorAll("details")].filter(
        (element) => ["浏览本栏目", "本页目录"].includes(
          element.querySelector(":scope > summary")?.textContent?.trim() ?? "",
        ),
      );
      return {
        articleVisible: (document.querySelector("article")
          ?.getBoundingClientRect().height ?? 0) > 0,
        hasHydrated: document.documentElement.dataset.hasHydrated === "true",
        nativeDetailsClosed: details.length === 2
          && details.every((element) => element.open === false),
        nativeDetailsVisible: details.length === 2
          && details.every((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }),
        pageOverflows: document.documentElement.scrollWidth
          > document.documentElement.clientWidth + 1
          || document.body.scrollWidth > document.body.clientWidth + 1,
      };
    })()`);
    assert.deepEqual(detail, {
      articleVisible: true,
      hasHydrated: false,
      nativeDetailsClosed: true,
      nativeDetailsVisible: true,
      pageOverflows: false,
    });
    assert.equal(
      await evaluate<boolean>(connection, `(() => {
        const summary = [...document.querySelectorAll("summary")].find(
          (element) => element.textContent?.trim() === "本页目录",
        );
        summary?.focus();
        return document.activeElement === summary;
      })()`),
      true,
      "无 hydration 时原生目录无法获得焦点",
    );
    await dispatchEnter(connection);
    assert.equal(
      await evaluate<boolean>(connection, `([...document.querySelectorAll("details")]
        .find((element) => element.querySelector(":scope > summary")
          ?.textContent?.trim() === "本页目录")?.open) === true`),
      true,
      "无 hydration 时原生目录无法由 Enter 展开",
    );
    assertExpectedLocalFailures(
      observation,
      /\.js:/u,
      /(?:ERR_BLOCKED_BY_(?:CLIENT|INSPECTOR)|blocked:inspector)/u,
    );
  } finally {
    await connection.send("Network.setBlockedURLs", {urls: []});
  }
}

async function closeBrowser(
  browserConnection: DevToolsConnection | undefined,
  pageConnection: DevToolsConnection | undefined,
  browserProcess: ChildProcess | undefined,
): Promise<void> {
  pageConnection?.close();
  if (browserConnection !== undefined) {
    try {
      await browserConnection.send("Browser.close");
    } catch {
      // Browser.close 会主动断开连接；随后仍以进程退出为准。
    }
    browserConnection.close();
  }
  if (browserProcess === undefined) return;
  const deadline = Date.now() + 5_000;
  while (
    browserProcess.exitCode === null
    && browserProcess.signalCode === null
    && Date.now() < deadline
  ) {
    await delay(25);
  }
  if (browserProcess.exitCode === null && browserProcess.signalCode === null) {
    browserProcess.kill("SIGKILL");
    await new Promise<void>((resolvePromise) => {
      browserProcess.once("exit", () => resolvePromise());
    });
  }
}

export async function runThemeBrowserRegression({
  buildRoot,
}: Readonly<{buildRoot: string}>): Promise<ThemeBrowserRegressionReceipt> {
  const browserExecutable = resolveBrowserExecutable();
  const temporaryParent = realpathSync(tmpdir());
  const profileRoot = mkdtempSync(join(temporaryParent, BROWSER_PROFILE_PREFIX));
  chmodSync(profileRoot, 0o700);
  assert.equal(dirname(profileRoot), temporaryParent);
  assert.ok(relative(temporaryParent, profileRoot).startsWith(BROWSER_PROFILE_PREFIX));
  let browserProcess: ChildProcess | undefined;
  let browserConnection: DevToolsConnection | undefined;
  let connection: DevToolsConnection | undefined;
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  let operationError: unknown;
  let cleanupError: unknown;
  let receipt: ThemeBrowserRegressionReceipt | undefined;

  try {
    server = await startStaticServer(buildRoot);
    browserProcess = startBrowser(browserExecutable, profileRoot);
    const endpoint = await waitForDevTools(profileRoot, browserProcess);
    browserConnection = await DevToolsConnection.connect(
      endpoint.browserWebSocketUrl,
    );
    const version = await browserConnection.send("Browser.getVersion");
    const browserProduct = sanitizeBrowserProduct(version.product);
    const pageWebSocketUrl = await resolvePageWebSocketUrl(endpoint);
    connection = await DevToolsConnection.connect(pageWebSocketUrl);
    await connection.send("Page.enable");
    await connection.send("Runtime.enable");
    await connection.send("Network.enable");
    await connection.send("Network.setCacheDisabled", {cacheDisabled: true});
    await connection.send("Log.enable");
    const observation = createObservation(connection, server.origin);
    const fixedViewports: FixedViewportReceipt[] = [];
    const detailRoute = "/writing/published-fixture-article/";
    const fixedCases = [
      {width: 1440, height: 900},
      {width: 1024, height: 768},
      {width: 768, height: 1024},
      {width: 360, height: 800},
      {width: 995, height: 800},
      {width: 996, height: 800},
      {width: 1279, height: 800},
      {width: 1280, height: 800},
    ] as const;

    for (const viewport of fixedCases) {
      await navigate(
        connection,
        observation,
        `${server.origin}${detailRoute}`,
        viewport.width,
        viewport.height,
      );
      const snapshot = await evaluate<DetailSnapshot>(
        connection,
        DETAIL_SNAPSHOT_EXPRESSION,
      );
      assertDetailSnapshot(snapshot, viewport.width);
      assertObservationClean(observation);
      const screenshot = await captureScreenshot(connection);
      fixedViewports.push(Object.freeze({
        height: viewport.height,
        route: detailRoute,
        screenshotBytes: screenshot.bytes,
        screenshotSha256: screenshot.sha256,
        width: viewport.width,
      }));
    }

    await navigate(
      connection,
      observation,
      `${server.origin}/writing/archived-fixture-article/`,
      1024,
      768,
    );
    const h4Only = await evaluate<Readonly<{
      h4Visible: boolean;
      tocAsideCount: number;
      tocNavCount: number;
      tocSummaryCount: number;
    }>>(connection, `(() => ({
      h4Visible: [...document.querySelectorAll("h4")].some(
        (element) => element.textContent?.includes("只有 H4 的边界标题") === true
          && element.getBoundingClientRect().height > 0,
      ),
      tocAsideCount: document.querySelectorAll('aside[aria-label="本页目录"]').length,
      tocNavCount: document.querySelectorAll('nav[aria-label="本页目录"]').length,
      tocSummaryCount: [...document.querySelectorAll("summary")].filter(
        (element) => element.textContent?.trim() === "本页目录",
      ).length,
    }))()`);
    assert.deepEqual(h4Only, {
      h4Visible: true,
      tocAsideCount: 0,
      tocNavCount: 0,
      tocSummaryCount: 0,
    });
    assertObservationClean(observation);

    await navigate(
      connection,
      observation,
      `${server.origin}${detailRoute}`,
      1024,
      768,
    );
    const proseLink = await evaluate<Readonly<{
      decoration: string;
      href: string;
    }>>(connection, `(() => {
      const link = [...document.querySelectorAll(".theme-doc-markdown a")].find(
        (element) => element.textContent?.trim() === "查看 fixture 项目",
      );
      return {
        decoration: getComputedStyle(link).textDecorationLine,
        href: link?.getAttribute("href") ?? "",
      };
    })()`);
    assert.equal(proseLink.href, "/projects/archived-fixture-project/");
    assert.match(proseLink.decoration, /\bunderline\b/u);
    assertObservationClean(observation);

    await navigate(
      connection,
      observation,
      `${server.origin}/projects/`,
      1440,
      900,
    );
    const priorityImage = await evaluate<Readonly<{
      complete: boolean;
      decoding: string;
      fetchPriority: string;
      isAboveFold: boolean;
      loading: string;
      naturalWidth: number;
    }>>(connection, `(() => {
      const image = document.querySelector("main img");
      const rect = image.getBoundingClientRect();
      return {
        complete: image.complete,
        decoding: image.decoding,
        fetchPriority: image.fetchPriority,
        isAboveFold: rect.top < innerHeight && rect.bottom > 0,
        loading: image.loading,
        naturalWidth: image.naturalWidth,
      };
    })()`);
    assert.deepEqual(priorityImage, {
      complete: true,
      decoding: "async",
      fetchPriority: "high",
      isAboveFold: true,
      loading: "eager",
      naturalWidth: 1600,
    });
    assertObservationClean(observation);

    await navigate(
      connection,
      observation,
      `${server.origin}/`,
      1440,
      900,
    );
    assert.equal(
      await evaluate(connection, "document.querySelector('main img')?.loading"),
      "lazy",
    );
    assertObservationClean(observation);

    await probeDelayedFailedProjectImage(
      connection,
      observation,
      `${server.origin}/projects/`,
      server.origin,
    );
    await probeNoHydrationStaticContent(
      connection,
      observation,
      server.origin,
      detailRoute,
    );

    await navigate(
      connection,
      observation,
      `${server.origin}${detailRoute}`,
      360,
      800,
      true,
    );
    const reducedMotion = await evaluate<Readonly<{
      activeMotionCount: number;
      durationsAreZero: boolean;
      fast: string;
      matches: boolean;
      scrollBehavior: string;
      slow: string;
    }>>(connection, `(() => {
      const durationIsZero = (value) => value.split(",").every(
        (entry) => Number.parseFloat(entry) === 0,
      );
      const elements = [
        document.querySelector(".navbar-sidebar"),
        document.querySelector(".navbar-sidebar__backdrop"),
        document.querySelector(".navbar-sidebar__items"),
      ].filter(Boolean);
      const root = getComputedStyle(document.documentElement);
      return {
        activeMotionCount: document.getAnimations({subtree: true}).filter((animation) => {
          const timing = animation.effect?.getComputedTiming();
          return animation.playState === "running"
            && typeof timing?.duration === "number"
            && timing.duration > 0.01;
        }).length,
        durationsAreZero: elements.every((element) => {
          const style = getComputedStyle(element);
          return durationIsZero(style.animationDuration)
            && durationIsZero(style.transitionDuration);
        }),
        fast: root.getPropertyValue("--ifm-transition-fast").trim(),
        matches: matchMedia("(prefers-reduced-motion: reduce)").matches,
        scrollBehavior: root.scrollBehavior,
        slow: root.getPropertyValue("--ifm-transition-slow").trim(),
      };
    })()`);
    assert.equal(reducedMotion.activeMotionCount, 0);
    assert.equal(reducedMotion.durationsAreZero, true);
    assert.match(reducedMotion.fast, /^0(?:\.0+)?(?:ms|s)$/u);
    assert.equal(reducedMotion.matches, true);
    assert.equal(reducedMotion.scrollBehavior, "auto");
    assert.match(reducedMotion.slow, /^0(?:\.0+)?(?:ms|s)$/u);
    assert.equal(
      await evaluate(connection, `new Promise((resolve) => {
        document.querySelector(".navbar__toggle")?.click();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          resolve(document.querySelector(".navbar-sidebar--show") !== null);
        }));
      })`),
      true,
    );
    assert.equal(
      await evaluate(connection, `(() => {
        const elements = [
          document.querySelector(".navbar-sidebar"),
          document.querySelector(".navbar-sidebar__backdrop"),
          document.querySelector(".navbar-sidebar__items"),
        ].filter(Boolean);
        return elements.every((element) => getComputedStyle(element)
          .transitionDuration.split(",")
          .every((entry) => Number.parseFloat(entry) === 0));
      })()`),
      true,
    );
    assertObservationClean(observation);

    await navigate(
      connection,
      observation,
      `${server.origin}${detailRoute}`,
      360,
      800,
    );
    const navbarToggleFocused = await evaluate<boolean>(connection, `(() => {
      const toggle = document.querySelector(".navbar__toggle");
      toggle?.focus();
      return document.activeElement === toggle;
    })()`);
    assert.equal(navbarToggleFocused, true, "小屏导航按钮无法获得键盘焦点");
    await dispatchEnter(connection);
    const openedNavbar = await evaluate<Readonly<{
      closeButtonVisible: boolean;
      drawerOpen: boolean;
      expanded: string;
    }>>(connection, `(() => {
      const closeButton = document.querySelector(".navbar-sidebar__close");
      const closeRect = closeButton?.getBoundingClientRect();
      return {
        closeButtonVisible: closeRect !== undefined
          && closeRect.width > 0
          && closeRect.height > 0,
        drawerOpen: document.querySelector(".navbar-sidebar--show") !== null,
        expanded: document.querySelector(".navbar__toggle")
          ?.getAttribute("aria-expanded") ?? "",
      };
    })()`);
    assert.deepEqual(openedNavbar, {
      closeButtonVisible: true,
      drawerOpen: true,
      expanded: "true",
    });
    await dispatchEscape(connection);
    const closedNavbar = await evaluate<Readonly<{
      drawerOpen: boolean;
      expanded: string;
      focusReturned: boolean;
    }>>(connection, `(() => {
      const toggle = document.querySelector(".navbar__toggle");
      return {
        drawerOpen: document.querySelector(".navbar-sidebar--show") !== null,
        expanded: toggle?.getAttribute("aria-expanded") ?? "",
        focusReturned: document.activeElement === toggle,
      };
    })()`);
    assert.deepEqual(closedNavbar, {
      drawerOpen: false,
      expanded: "false",
      focusReturned: true,
    });
    for (const label of ["浏览本栏目", "本页目录"]) {
      const focused: boolean = await evaluate<boolean>(connection, `(() => {
        const summary = [...document.querySelectorAll("summary")].find(
          (element) => element.textContent?.trim() === ${JSON.stringify(label)},
        );
        summary?.focus();
        return document.activeElement === summary;
      })()`);
      assert.equal(focused, true, `${label} 无法获得键盘焦点`);
      await dispatchEnter(connection);
      const keyboardState: Readonly<{
        isOpen: boolean;
        outlineWidth: string;
      }> = await evaluate(connection, `(() => {
        const summary = [...document.querySelectorAll("summary")].find(
          (element) => element.textContent?.trim() === ${JSON.stringify(label)},
        );
        return {
          isOpen: summary?.parentElement?.open === true,
          outlineWidth: getComputedStyle(summary).outlineWidth,
        };
      })()`);
      assert.equal(keyboardState.isOpen, true, `${label} 无法由 Enter 展开`);
      assert.equal(keyboardState.outlineWidth, "3px", `${label} 焦点轮廓不清晰`);
      await dispatchEnter(connection);
    }
    assertObservationClean(observation);

    await navigate(
      connection,
      observation,
      `${server.origin}${detailRoute}`,
      360,
      800,
    );
    const textResize = await evaluate<Readonly<{
      afterFontSize: number;
      baselineFontSize: number;
      criticalElementsFit: boolean;
      pageOverflows: boolean;
    }>>(connection, `new Promise((resolve) => {
      const baselineFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      const style = document.createElement("style");
      style.textContent = "html { font-size: 200% !important; }";
      document.head.append(style);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const afterFontSize = Number.parseFloat(
          getComputedStyle(document.documentElement).fontSize,
        );
        const critical = [
          document.querySelector("h1"),
          document.querySelector(".theme-doc-markdown"),
          ...document.querySelectorAll("summary"),
          document.querySelector("footer"),
        ].filter(Boolean);
        resolve({
          afterFontSize,
          baselineFontSize,
          criticalElementsFit: critical.every((element) => {
            const rect = element.getBoundingClientRect();
            return rect.left >= -1 && rect.right <= document.documentElement.clientWidth + 1;
          }),
          pageOverflows: document.documentElement.scrollWidth
            > document.documentElement.clientWidth + 1
            || document.body.scrollWidth > document.body.clientWidth + 1,
        });
      }));
    })`);
    assert.ok(
      textResize.afterFontSize >= textResize.baselineFontSize * 1.9,
      "200% 根文本探针未实际放大字号",
    );
    assert.equal(textResize.criticalElementsFit, true, "200% 文本裁切关键内容");
    assert.equal(textResize.pageOverflows, false, "200% 文本产生页面级横向溢出");
    assertObservationClean(observation);

    for (const route of ["/", "/projects/", "/writing/"]) {
      await navigate(
        connection,
        observation,
        `${server.origin}${route}`,
        320,
        800,
      );
      assert.equal(
        await evaluate(connection, `document.documentElement.scrollWidth
          > document.documentElement.clientWidth + 1
          || document.body.scrollWidth > document.body.clientWidth + 1`),
        false,
        `320px 页面发生横向溢出：${route}`,
      );
      assertObservationClean(observation);
    }

    receipt = Object.freeze({
      browserProduct,
      fixedViewports: Object.freeze(fixedViewports),
      probes: Object.freeze([
        "320px-overflow",
        "failed-project-image-layout",
        "h4-only-empty-toc",
        "hydration-ready",
        "keyboard-details",
        "keyboard-navbar-escape",
        "no-hydration-static-content",
        "priority-project-image",
        "prose-link-decoration",
        "reduced-motion",
        "text-only-200-percent",
      ]),
    });
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await closeBrowser(browserConnection, connection, browserProcess);
    } catch (error) {
      cleanupError = error;
    }
    if (server !== undefined) {
      try {
        await server.close();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    try {
      assert.equal(realpathSync(profileRoot), profileRoot);
      assert.equal(dirname(profileRoot), temporaryParent);
      assert.ok(relative(temporaryParent, profileRoot).startsWith(
        BROWSER_PROFILE_PREFIX,
      ));
      rmSync(profileRoot, {recursive: true, force: false});
    } catch (error) {
      cleanupError ??= error;
    }
  }

  if (cleanupError !== undefined) {
    throw new Error("[BROWSER_CLEANUP] Chromium 私有状态清理失败", {
      cause: operationError === undefined
        ? cleanupError
        : new AggregateError([operationError, cleanupError]),
    });
  }
  if (operationError !== undefined) throw operationError;
  assert.ok(receipt !== undefined);
  return receipt;
}
