import {spawnSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {isIP} from "node:net";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {
  CANONICAL_ORIGIN,
  collectPublicHtmlRoutes,
  compileRuntimeRedirectArtifacts,
  parseRedirectRegistry,
} from "./runtime-redirects.mjs";

export const NGINX_ACCEPTANCE_IMAGE =
  "docker.io/library/nginx@sha256:0dcc88822d45581e65ae329f8be769762bf628d3b2bb7d2a077d4aa5c98b30e3";
export const NGINX_ACCEPTANCE_PLATFORM = "linux/amd64";
export const NGINX_ACCEPTANCE_VERSION = "nginx/1.28.3";
export const NGINX_ACCEPTANCE_HTTP_ASSERTION_COUNT = 25;
const NGINX_ACCEPTANCE_MANIFEST_DIGEST =
  "sha256:0dcc88822d45581e65ae329f8be769762bf628d3b2bb7d2a077d4aa5c98b30e3";

const DOCKER_EXECUTABLE = "/usr/bin/docker";
const DOCKER_HOST = "unix:///var/run/docker.sock";
const OPENSSL_EXECUTABLE = "/usr/bin/openssl";
const RESOURCE_LABEL = "com.axialmuse.runtime-redirect-acceptance";
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const EXPECTED_NODE_VERSION = "24.18.0";
const CONTAINER_PORTS = Object.freeze({
  rootHttp: 8080,
  wwwHttp: 8081,
  rootHttps: 8443,
  wwwHttps: 8444,
});
const TARGET_SENTINELS = Object.freeze({
  "/": "AXIAL_MUSE_ROOT_ACCEPTANCE\n",
  "/new/": "AXIAL_MUSE_NEW_TARGET_ACCEPTANCE\n",
  "/projects/": "AXIAL_MUSE_PROJECTS_TARGET_ACCEPTANCE\n",
});
const ACME_PATH =
  "/.well-known/acme-challenge/axial-muse-nginx-acceptance";
const ACME_SENTINEL = "AXIAL_MUSE_ACME_ACCEPTANCE\n";
const CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
]);

export class NginxDockerAcceptanceError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "NginxDockerAcceptanceError";
    this.code = code;
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: false,
        enumerable: false,
        value: cause,
        writable: false,
      });
    }
  }
}

function fail(code, message, cause) {
  throw new NginxDockerAcceptanceError(code, message, cause);
}

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasErrorCode(value, code) {
  return (
    value !== null
    && typeof value === "object"
    && value.code === code
  );
}

function parseJson(text, code, message) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    fail(code, message, cause);
  }
}

function assertExecutable(path, code) {
  try {
    if (realpathSync(path) !== path) {
      throw new TypeError("executable path is not canonical");
    }
    const metadata = lstatSync(path, {bigint: true});
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1n
      || (metadata.mode & 0o111n) === 0n
      || (metadata.mode & 0o002n) !== 0n
    ) {
      throw new TypeError("executable identity is not trusted");
    }
  } catch (cause) {
    fail(code, "本机验收可执行文件身份不合法。", cause);
  }
}

function childEnvironment(home) {
  const environment = {
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/usr/bin:/bin",
  };
  if (
    Object.keys(environment).sort(compareAscii).join("\0")
    !== [...CHILD_ENVIRONMENT_KEYS].sort(compareAscii).join("\0")
  ) {
    fail("NGINX_ACCEPTANCE_INTERNAL", "子进程环境边界不合法。");
  }
  return Object.freeze(environment);
}

function rawCommand({
  arguments_,
  command,
  cwd,
  environment,
  spawnProcess,
}) {
  const result = spawnProcess(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: environment,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  return Object.freeze({
    error: result.error,
    signal: result.signal ?? null,
    status: result.status,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  });
}

function requireCommand(result, code, message) {
  if (result.error || result.signal !== null || result.status !== 0) {
    fail(code, message, result.error);
  }
  return result;
}

function dockerGlobalArguments(dockerConfigRoot) {
  return [
    "--config",
    dockerConfigRoot,
    "--host",
    DOCKER_HOST,
  ];
}

function createDockerClient({
  cwd,
  dockerConfigRoot,
  environment,
  spawnProcess,
}) {
  const invoke = (arguments_) => rawCommand({
    arguments_: [
      ...dockerGlobalArguments(dockerConfigRoot),
      ...arguments_,
    ],
    command: DOCKER_EXECUTABLE,
    cwd,
    environment,
    spawnProcess,
  });
  return Object.freeze({
    invoke,
    require(arguments_, code, message) {
      return requireCommand(invoke(arguments_), code, message);
    },
  });
}

function dockerNotFound(result, resourceKind, name) {
  if (result.error || result.signal !== null || result.status === 0) {
    return false;
  }
  const expected = resourceKind === "container"
    ? `Error response from daemon: No such container: ${name}`
    : `Error response from daemon: network ${name} not found`;
  return result.stdout.trim() === "[]" && result.stderr.trim() === expected;
}

function ensureDockerResourceAbsent(docker, resourceKind, name) {
  const result = docker.invoke([resourceKind, "inspect", name]);
  if (dockerNotFound(result, resourceKind, name)) return;
  if (result.status === 0) {
    fail(
      "NGINX_ACCEPTANCE_RESOURCE_COLLISION",
      "随机验收资源名称发生冲突。",
    );
  }
  fail(
    "NGINX_ACCEPTANCE_DOCKER_DAEMON",
    "无法确认本地 Docker 验收资源不存在。",
    result.error,
  );
}

function requireDockerEngine(docker) {
  const result = docker.require(
    ["version", "--format", "{{json .Server.Version}}"],
    "NGINX_ACCEPTANCE_DOCKER_DAEMON",
    "无法访问固定本地 Docker Engine。",
  );
  const version = parseJson(
    result.stdout.trim(),
    "NGINX_ACCEPTANCE_DOCKER_DAEMON",
    "Docker Engine 版本输出不可解析。",
  );
  const match = typeof version === "string"
    ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+].*)?$/u.exec(version)
    : null;
  if (match === null || Number(match[1]) < 28) {
    fail(
      "NGINX_ACCEPTANCE_DOCKER_VERSION",
      "Docker Engine 必须至少为 28.0.0，才能使用已验收的内部网络语义。",
    );
  }
  return version;
}

function requirePinnedImage(docker) {
  const result = docker.require(
    ["image", "inspect", NGINX_ACCEPTANCE_IMAGE],
    "NGINX_ACCEPTANCE_IMAGE",
    "固定 Nginx 镜像未在本地缓存；验收入口不会隐式拉取。",
  );
  const decoded = parseJson(
    result.stdout,
    "NGINX_ACCEPTANCE_IMAGE",
    "固定 Nginx 镜像身份不可解析。",
  );
  if (
    !Array.isArray(decoded)
    || decoded.length !== 1
    || !isPlainRecord(decoded[0])
    || decoded[0].Os !== "linux"
    || decoded[0].Architecture !== "amd64"
    || typeof decoded[0].Id !== "string"
    || !/^sha256:[0-9a-f]{64}$/u.test(decoded[0].Id)
    || !Array.isArray(decoded[0].RepoDigests)
    || decoded[0].RepoDigests.length === 0
    || decoded[0].RepoDigests.some((identity) => (
      identity !== `nginx@${NGINX_ACCEPTANCE_MANIFEST_DIGEST}`
      && identity !==
        `docker.io/library/nginx@${NGINX_ACCEPTANCE_MANIFEST_DIGEST}`
    ))
  ) {
    fail(
      "NGINX_ACCEPTANCE_IMAGE",
      "固定 Nginx 镜像的平台或内容身份不合法。",
    );
  }
  return Object.freeze({
    architecture: decoded[0].Architecture,
    id: decoded[0].Id,
    os: decoded[0].Os,
  });
}

function commonContainerArguments({
  labelValue,
  name,
  network,
}) {
  return [
    "--name",
    name,
    "--label",
    `${RESOURCE_LABEL}=${labelValue}`,
    "--network",
    network,
    "--pull",
    "never",
    "--platform",
    NGINX_ACCEPTANCE_PLATFORM,
    "--user",
    "65534:65534",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--read-only",
    "--pids-limit",
    "64",
    "--memory",
    "64m",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
    "--entrypoint",
    "/usr/sbin/nginx",
  ];
}

const NGINX_CONTAINER_OPTION_ARITY = Object.freeze({
  "--add-host": 1,
  "--cap-drop": 1,
  "--entrypoint": 1,
  "--label": 1,
  "--memory": 1,
  "--mount": 1,
  "--name": 1,
  "--network": 1,
  "--pids-limit": 1,
  "--platform": 1,
  "--pull": 1,
  "--read-only": 0,
  "--restart": 1,
  "--security-opt": 1,
  "--tmpfs": 1,
  "--user": 1,
});

export function assertPinnedNginxContainerArguments(arguments_) {
  if (
    !Array.isArray(arguments_)
    || arguments_.some((argument) => typeof argument !== "string")
    || arguments_[0] !== "container"
    || !["create", "run"].includes(arguments_[1])
  ) {
    fail(
      "NGINX_ACCEPTANCE_DOCKER_ARGUMENTS",
      "Nginx 容器命令结构不合法。",
    );
  }
  const optionValues = new Map();
  let index = 2;
  while (
    index < arguments_.length
    && arguments_[index] !== NGINX_ACCEPTANCE_IMAGE
  ) {
    const option = arguments_[index];
    const arity = NGINX_CONTAINER_OPTION_ARITY[option];
    if (arity === undefined) {
      fail(
        "NGINX_ACCEPTANCE_DOCKER_ARGUMENTS",
        "Nginx 容器命令包含未准入选项或镜像选择器。",
      );
    }
    const values = arguments_.slice(index + 1, index + 1 + arity);
    if (
      values.length !== arity
      || values.some((value) => (
        value === NGINX_ACCEPTANCE_IMAGE
        || Object.hasOwn(NGINX_CONTAINER_OPTION_ARITY, value)
      ))
    ) {
      fail(
        "NGINX_ACCEPTANCE_DOCKER_ARGUMENTS",
        "Nginx 容器命令选项值不完整。",
      );
    }
    const existing = optionValues.get(option) ?? [];
    existing.push(Object.freeze(values));
    optionValues.set(option, existing);
    index += 1 + arity;
  }
  if (
    arguments_[index] !== NGINX_ACCEPTANCE_IMAGE
    || arguments_.filter(
      (argument) => argument === NGINX_ACCEPTANCE_IMAGE,
    ).length !== 1
    || optionValues.get("--pull")?.length !== 1
    || optionValues.get("--pull")[0][0] !== "never"
    || optionValues.get("--platform")?.length !== 1
    || optionValues.get("--platform")[0][0] !== NGINX_ACCEPTANCE_PLATFORM
  ) {
    fail(
      "NGINX_ACCEPTANCE_DOCKER_ARGUMENTS",
      "Nginx 容器命令没有固定 digest、平台或 no-pull 约束。",
    );
  }
  return arguments_;
}

function mountArguments(fixture) {
  return [
    "--mount",
    `type=bind,src=${fixture.configRoot},dst=/acceptance/config,readonly`,
    "--mount",
    `type=bind,src=${fixture.payloadRoot},dst=/acceptance/payload,readonly`,
    "--mount",
    `type=bind,src=${fixture.acmeRoot},dst=/acceptance/acme-root,readonly`,
    "--mount",
    `type=bind,src=${fixture.tlsRoot},dst=/acceptance/tls,readonly`,
    "--mount",
    `type=bind,src=${fixture.tls.certificatePath},dst=/etc/ssl/certs/ca-certificates.crt,readonly`,
  ];
}

export function buildNginxServiceCreateArguments({
  fixture,
  labelValue,
  name,
  network,
}) {
  return assertPinnedNginxContainerArguments([
    "container",
    "create",
    ...commonContainerArguments({
      labelValue,
      name,
      network,
    }),
    "--restart",
    "no",
    "--add-host",
    "axialmuse.com:127.0.0.1",
    "--add-host",
    "www.axialmuse.com:127.0.0.1",
    "--add-host",
    "unknown.invalid:127.0.0.1",
    ...mountArguments(fixture),
    NGINX_ACCEPTANCE_IMAGE,
    "-c",
    "/acceptance/config/nginx.conf",
    "-g",
    "daemon off;",
  ]);
}

function knownServer({
  host,
  port,
  tls,
  canonical,
  acme,
}) {
  const listen = tls ? `${port} ssl` : `${port}`;
  const acmeLocation = acme
    ? `  location ^~ /.well-known/acme-challenge/ {
    root /acceptance/acme-root;
    try_files $uri =404;
  }
`
    : "";
  const fallback = canonical
    ? `  root /acceptance/payload;
  location / {
    try_files $uri $uri/ =404;
  }`
    : `  location / {
    return 301 https://www.axialmuse.com$request_uri;
  }`;
  return `server {
  listen ${listen};
  server_name ${host};
  include /acceptance/config/redirects.conf;
${acmeLocation}${fallback}
}`;
}

function defaultServer({port, tls}) {
  const listen = tls ? `${port} ssl default_server` : `${port} default_server`;
  return `server {
  listen ${listen};
  server_name _;
  location / {
    return 404;
  }
}`;
}

export function renderNginxAcceptanceConfiguration() {
  const servers = [
    defaultServer({port: CONTAINER_PORTS.rootHttp, tls: false}),
    knownServer({
      acme: true,
      canonical: false,
      host: "axialmuse.com",
      port: CONTAINER_PORTS.rootHttp,
      tls: false,
    }),
    defaultServer({port: CONTAINER_PORTS.wwwHttp, tls: false}),
    knownServer({
      acme: true,
      canonical: false,
      host: "www.axialmuse.com",
      port: CONTAINER_PORTS.wwwHttp,
      tls: false,
    }),
    defaultServer({port: CONTAINER_PORTS.rootHttps, tls: true}),
    knownServer({
      acme: false,
      canonical: false,
      host: "axialmuse.com",
      port: CONTAINER_PORTS.rootHttps,
      tls: true,
    }),
    defaultServer({port: CONTAINER_PORTS.wwwHttps, tls: true}),
    knownServer({
      acme: false,
      canonical: true,
      host: "www.axialmuse.com",
      port: CONTAINER_PORTS.wwwHttps,
      tls: true,
    }),
  ];
  return `worker_processes 1;
pid /tmp/nginx.pid;
error_log stderr notice;

events {
  worker_connections 64;
}

http {
  access_log off;
  server_tokens off;
  default_type text/plain;
  index index.html;
  sendfile off;
  client_body_temp_path /tmp/client-body;
  proxy_temp_path /tmp/proxy;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  ssl_session_cache off;
  ssl_certificate /acceptance/tls/certificate.pem;
  ssl_certificate_key /acceptance/tls/private-key.pem;

${servers.join("\n\n")}
}
`;
}

function writeFixtureFile(root, relativePath, value) {
  ensureReadableFixtureDirectory(root);
  let directory = root;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    directory = resolve(directory, segment);
    ensureReadableFixtureDirectory(directory);
  }
  const path = resolve(root, relativePath);
  writeFileSync(path, value, {encoding: "utf8", mode: 0o444});
  chmodSync(path, 0o444);
  return path;
}

function ensureReadableFixtureDirectory(path) {
  mkdirSync(path, {recursive: true, mode: 0o755});
  chmodSync(path, 0o755);
}

function generateTlsFixture({
  commandEnvironment,
  repositoryRoot,
  spawnProcess,
  tlsRoot,
}) {
  ensureReadableFixtureDirectory(tlsRoot);
  const certificatePath = resolve(tlsRoot, "certificate.pem");
  const privateKeyPath = resolve(tlsRoot, "private-key.pem");
  const result = rawCommand({
    arguments_: [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "1",
      "-set_serial",
      "1",
      "-subj",
      "/CN=www.axialmuse.com",
      "-addext",
      "subjectAltName=DNS:www.axialmuse.com,DNS:axialmuse.com,DNS:unknown.invalid",
      "-keyout",
      privateKeyPath,
      "-out",
      certificatePath,
    ],
    command: OPENSSL_EXECUTABLE,
    cwd: repositoryRoot,
    environment: commandEnvironment,
    spawnProcess,
  });
  requireCommand(
    result,
    "NGINX_ACCEPTANCE_TLS",
    "无法生成隔离验收用的临时自签名证书。",
  );
  try {
    for (const path of [certificatePath, privateKeyPath]) {
      const metadata = lstatSync(path, {bigint: true});
      if (
        !metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.nlink !== 1n
        || metadata.size === 0n
      ) {
        throw new TypeError("invalid TLS fixture member");
      }
      chmodSync(path, 0o444);
    }
  } catch (cause) {
    fail(
      "NGINX_ACCEPTANCE_TLS",
      "隔离验收用的临时证书身份不合法。",
      cause,
    );
  }
  return Object.freeze({
    certificate: readFileSync(certificatePath),
    certificatePath,
    privateKeyPath,
  });
}

function createAcceptanceFixture({
  commandEnvironment,
  repositoryRoot,
  spawnProcess,
  temporaryRoot,
}) {
  const payloadRoot = resolve(temporaryRoot, "payload");
  const acmeRoot = resolve(temporaryRoot, "acme-root");
  const configRoot = resolve(temporaryRoot, "config");
  const tlsRoot = resolve(temporaryRoot, "tls");
  for (const root of [payloadRoot, acmeRoot, configRoot]) {
    ensureReadableFixtureDirectory(root);
  }
  writeFixtureFile(payloadRoot, "index.html", TARGET_SENTINELS["/"]);
  writeFixtureFile(
    payloadRoot,
    "new/index.html",
    TARGET_SENTINELS["/new/"],
  );
  writeFixtureFile(
    payloadRoot,
    "projects/index.html",
    TARGET_SENTINELS["/projects/"],
  );
  writeFixtureFile(
    acmeRoot,
    ACME_PATH.slice(1),
    ACME_SENTINEL,
  );

  const registry = parseRedirectRegistry(new TextEncoder().encode(
    `${JSON.stringify({
      version: "0.1.0",
      kind: "axial_muse_redirects",
      status: "active",
      owner: "AxialMuseWebsite",
      redirects: [{
        from: "/old/",
        to: "/new/",
        reason: "隔离 Nginx 真实行为验收 fixture",
      }],
    }, null, 2)}\n`,
  ));
  const artifacts = compileRuntimeRedirectArtifacts({
    canonicalOrigin: CANONICAL_ORIGIN,
    publicRoutes: collectPublicHtmlRoutes(payloadRoot),
    registry,
  });
  if (
    artifacts.registeredRuleCount !== 2
    || artifacts.canonicalSlashRuleCount !== 2
  ) {
    fail(
      "NGINX_ACCEPTANCE_FIXTURE",
      "隔离验收重定向规则闭包不符合预期。",
    );
  }
  writeFixtureFile(
    configRoot,
    "redirects.conf",
    artifacts.nginxRedirectsConfig,
  );
  writeFixtureFile(
    configRoot,
    "nginx.conf",
    renderNginxAcceptanceConfiguration(),
  );
  for (const relativePath of [
    "old",
    "old/index.html",
    "old.html",
  ]) {
    try {
      lstatSync(resolve(payloadRoot, relativePath));
      fail(
        "NGINX_ACCEPTANCE_FIXTURE",
        "隔离 payload 不得包含 redirect source 静态页面。",
      );
    } catch (cause) {
      if (
        cause instanceof NginxDockerAcceptanceError
        || !hasErrorCode(cause, "ENOENT")
      ) {
        throw cause;
      }
    }
  }
  const tls = generateTlsFixture({
    commandEnvironment,
    repositoryRoot,
    spawnProcess,
    tlsRoot,
  });
  return Object.freeze({
    acmeRoot,
    artifacts,
    configRoot,
    payloadRoot,
    tls,
    tlsRoot,
  });
}

function parseDockerInspect(result, code, message) {
  const decoded = parseJson(result.stdout, code, message);
  if (
    !Array.isArray(decoded)
    || decoded.length !== 1
    || !isPlainRecord(decoded[0])
  ) {
    fail(code, message);
  }
  return decoded[0];
}

function requireResourceLabel(document, labelValue, code) {
  if (
    !isPlainRecord(document.Config)
    || !isPlainRecord(document.Config.Labels)
    || document.Config.Labels[RESOURCE_LABEL] !== labelValue
  ) {
    fail(code, "Docker 验收资源标签身份不匹配。");
  }
}

function requireNetworkIdentity(docker, name, labelValue) {
  const result = docker.require(
    ["network", "inspect", name],
    "NGINX_ACCEPTANCE_DOCKER_NETWORK",
    "无法检查隔离 Docker 网络。",
  );
  const network = parseDockerInspect(
    result,
    "NGINX_ACCEPTANCE_DOCKER_NETWORK",
    "隔离 Docker 网络身份不可解析。",
  );
  if (
    typeof network.Id !== "string"
    || !/^[0-9a-f]{64}$/u.test(network.Id)
    || network.Name !== name
    || network.Driver !== "bridge"
    || network.Internal !== true
    || network.EnableIPv6 !== false
    || !isPlainRecord(network.Labels)
    || network.Labels[RESOURCE_LABEL] !== labelValue
  ) {
    fail(
      "NGINX_ACCEPTANCE_DOCKER_NETWORK",
      "隔离 Docker 网络属性不合法。",
    );
  }
  return network;
}

function requireExclusiveNetworkMember({
  address,
  containerId,
  docker,
  labelValue,
  networkId,
  networkName,
  serviceName,
}) {
  const network = requireNetworkIdentity(docker, networkName, labelValue);
  const member = network.Containers?.[containerId];
  if (
    network.Id !== networkId
    || !isPlainRecord(network.Containers)
    || Object.keys(network.Containers).length !== 1
    || !isPlainRecord(member)
    || member.Name !== serviceName
    || typeof member.IPv4Address !== "string"
    || !member.IPv4Address.startsWith(`${address}/`)
  ) {
    fail(
      "NGINX_ACCEPTANCE_DOCKER_NETWORK",
      "隔离 Docker 网络不得包含候选以外的成员。",
    );
  }
}

export function extractInternalServiceEndpoint(document, networkName) {
  if (
    !isPlainRecord(document)
    || !isPlainRecord(document.HostConfig)
    || !isPlainRecord(document.NetworkSettings)
    || document.HostConfig.ReadonlyRootfs !== true
    || document.HostConfig.NetworkMode === "default"
    || !Array.isArray(document.HostConfig.CapDrop)
    || !document.HostConfig.CapDrop.includes("ALL")
    || !Array.isArray(document.HostConfig.SecurityOpt)
    || !document.HostConfig.SecurityOpt.includes("no-new-privileges=true")
    || document.Config?.User !== "65534:65534"
    || document.HostConfig.NetworkMode !== networkName
  ) {
    fail(
      "NGINX_ACCEPTANCE_DOCKER_SERVICE",
      "Nginx 验收容器的隔离属性不合法。",
    );
  }
  const configuredBindings = document.HostConfig.PortBindings;
  if (
    configuredBindings !== null
    && (
      !isPlainRecord(configuredBindings)
      || Object.keys(configuredBindings).length !== 0
    )
  ) {
    fail(
      "NGINX_ACCEPTANCE_DOCKER_PORT",
      "Nginx 验收容器不得发布任何宿主端口。",
    );
  }
  const ports = document.NetworkSettings.Ports;
  if (!isPlainRecord(ports)) {
    fail(
      "NGINX_ACCEPTANCE_DOCKER_PORT",
      "Nginx 验收容器端口事实不可解析。",
    );
  }
  for (const bindings of Object.values(ports)) {
    if (bindings !== null) {
      fail(
        "NGINX_ACCEPTANCE_DOCKER_PORT",
        "Nginx 验收容器存在非空宿主端口发布事实。",
      );
    }
  }
  const networks = document.NetworkSettings.Networks;
  if (
    !isPlainRecord(networks)
    || Object.keys(networks).length !== 1
    || !isPlainRecord(networks[networkName])
    || isIP(networks[networkName].IPAddress) !== 4
    || networks[networkName].Gateway !== ""
    || typeof networks[networkName].NetworkID !== "string"
    || !/^[0-9a-f]{64}$/u.test(networks[networkName].NetworkID)
  ) {
    fail(
      "NGINX_ACCEPTANCE_DOCKER_NETWORK",
      "Nginx 验收容器没有唯一内部 IPv4 网络身份。",
    );
  }
  return Object.freeze({
    address: networks[networkName].IPAddress,
    networkId: networks[networkName].NetworkID,
    ports: CONTAINER_PORTS,
  });
}

function rawLocationValues(rawHeaders) {
  if (
    !Array.isArray(rawHeaders)
    || rawHeaders.length % 2 !== 0
    || rawHeaders.some((value) => typeof value !== "string")
  ) {
    fail("NGINX_ACCEPTANCE_HTTP", "HTTP 原始响应头不可解析。");
  }
  const values = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === "location") {
      values.push(rawHeaders[index + 1]);
    }
  }
  return values;
}

export function assertAcceptanceHttpResponse(response, expectation) {
  if (
    !isPlainRecord(response)
    || !Number.isInteger(response.statusCode)
    || typeof response.body !== "string"
  ) {
    fail("NGINX_ACCEPTANCE_HTTP", "HTTP 响应结构不合法。");
  }
  const locations = rawLocationValues(response.rawHeaders);
  if (response.statusCode !== expectation.statusCode) {
    fail("NGINX_ACCEPTANCE_HTTP", "Nginx HTTP 状态不符合预期。");
  }
  if (expectation.location === undefined) {
    if (locations.length !== 0) {
      fail("NGINX_ACCEPTANCE_HTTP", "非跳转响应不得包含 Location。");
    }
  } else if (
    locations.length !== 1
    || locations[0] !== expectation.location
  ) {
    fail(
      "NGINX_ACCEPTANCE_HTTP",
      "301 响应必须包含唯一且精确的 Location。",
    );
  }
  if (
    expectation.body !== undefined
    && response.body !== expectation.body
  ) {
    fail("NGINX_ACCEPTANCE_HTTP", "Nginx HTTP 响应正文不符合预期。");
  }
}

export function parseBusyBoxWgetResponse(result) {
  if (
    !isPlainRecord(result)
    || result.error
    || result.signal !== null
    || !Number.isInteger(result.status)
    || typeof result.stderr !== "string"
    || typeof result.stdout !== "string"
  ) {
    fail("NGINX_ACCEPTANCE_HTTP", "BusyBox wget 执行结果不合法。");
  }
  const lines = result.stderr.split(/\r?\n/u);
  const statusLines = [];
  for (const [index, line] of lines.entries()) {
    const match = /^\s+HTTP\/1\.[01] ([1-5]\d\d)(?:\s|$)/u.exec(line);
    if (match !== null) {
      statusLines.push(Object.freeze({
        index,
        statusCode: Number(match[1]),
      }));
    }
  }
  if (statusLines.length !== 1) {
    fail(
      "NGINX_ACCEPTANCE_HTTP",
      "BusyBox wget 必须捕获恰好一个 HTTP 响应。",
    );
  }
  const rawHeaders = [];
  for (
    let index = statusLines[0].index + 1;
    index < lines.length;
    index += 1
  ) {
    const match =
      /^\s+([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/u.exec(lines[index]);
    if (match === null) {
      if (rawHeaders.length > 0) break;
      continue;
    }
    rawHeaders.push(match[1], match[2]);
  }
  return Object.freeze({
    body: result.stdout,
    exitStatus: result.status,
    rawHeaders: Object.freeze(rawHeaders),
    statusCode: statusLines[0].statusCode,
  });
}

export function buildNginxAcceptanceRequestCases(ports) {
  const roles = Object.freeze([
    Object.freeze({
      host: "axialmuse.com",
      port: ports.rootHttp,
      protocol: "http:",
      role: "root-http",
    }),
    Object.freeze({
      host: "www.axialmuse.com",
      port: ports.wwwHttp,
      protocol: "http:",
      role: "www-http",
    }),
    Object.freeze({
      host: "axialmuse.com",
      port: ports.rootHttps,
      protocol: "https:",
      role: "root-https",
    }),
    Object.freeze({
      host: "www.axialmuse.com",
      port: ports.wwwHttps,
      protocol: "https:",
      role: "www-https",
    }),
  ]);
  const cases = [];
  for (const role of roles) {
    for (const [path, location] of [
      ["/old", `${CANONICAL_ORIGIN}/new/`],
      ["/old/", `${CANONICAL_ORIGIN}/new/`],
      ["/projects", `${CANONICAL_ORIGIN}/projects/`],
      [
        "/old?alpha=1&encoded=%2F&empty=",
        `${CANONICAL_ORIGIN}/new/?alpha=1&encoded=%2F&empty=`,
      ],
    ]) {
      cases.push(Object.freeze({
        ...role,
        expectation: Object.freeze({location, statusCode: 301}),
        path,
      }));
    }
    cases.push(Object.freeze({
      ...role,
      expectation: Object.freeze({statusCode: 404}),
      host: "unknown.invalid",
      path: "/old?unknown=1",
    }));
  }
  for (const role of roles.filter((item) => item.protocol === "http:")) {
    cases.push(Object.freeze({
      ...role,
      expectation: Object.freeze({
        body: ACME_SENTINEL,
        statusCode: 200,
      }),
      path: ACME_PATH,
    }));
  }
  const canonical = roles.find((item) => item.role === "www-https");
  for (const [path, body] of Object.entries(TARGET_SENTINELS)) {
    cases.push(Object.freeze({
      ...canonical,
      expectation: Object.freeze({body, statusCode: 200}),
      path,
    }));
  }
  if (cases.length !== NGINX_ACCEPTANCE_HTTP_ASSERTION_COUNT) {
    fail(
      "NGINX_ACCEPTANCE_HTTP_MATRIX",
      "Nginx HTTP 验收矩阵数量发生漂移。",
    );
  }
  return Object.freeze(cases);
}

function executeWgetRequest({
  docker,
  expectation,
  host,
  path,
  port,
  protocol,
  serviceName,
}) {
  const commandResult = docker.invoke([
    "container",
    "exec",
    "--user",
    "65534:65534",
    serviceName,
    "/usr/bin/wget",
    "-S",
    "-O",
    "-",
    "-T",
    "2",
    "-Y",
    "off",
    `${protocol}//${host}:${port}${path}`,
  ]);
  let response;
  try {
    response = parseBusyBoxWgetResponse(commandResult);
    if (
      (expectation.statusCode === 200 && response.exitStatus !== 0)
      || (expectation.statusCode !== 200 && response.exitStatus === 0)
    ) {
      fail(
        "NGINX_ACCEPTANCE_HTTP",
        "BusyBox wget 退出状态与首个 HTTP 响应不一致。",
      );
    }
    assertAcceptanceHttpResponse(response, expectation);
  } catch (cause) {
    fail(
      "NGINX_ACCEPTANCE_HTTP",
      "BusyBox wget 响应没有通过 HTTP 契约。",
      Object.freeze({
        cause,
        commandResult,
        expectation,
        response,
      }),
    );
  }
  return response;
}

function pause(milliseconds) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, milliseconds);
}

function waitForService({
  docker,
  isInterrupted,
  port,
  serviceName,
}) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (isInterrupted()) {
      fail("NGINX_ACCEPTANCE_INTERRUPTED", "Nginx 验收被中断。");
    }
    try {
      executeWgetRequest({
        docker,
        expectation: {
          body: TARGET_SENTINELS["/"],
          statusCode: 200,
        },
        host: "www.axialmuse.com",
        path: "/",
        port,
        protocol: "https:",
        serviceName,
      });
      return;
    } catch (cause) {
      lastError = cause;
      pause(100);
    }
  }
  fail(
    "NGINX_ACCEPTANCE_DOCKER_SERVICE",
    "Nginx 验收服务未在时限内就绪。",
    lastError,
  );
}

function runHttpAcceptance({
  docker,
  isInterrupted,
  ports,
  serviceName,
}) {
  waitForService({
    docker,
    isInterrupted,
    port: ports.wwwHttps,
    serviceName,
  });
  const cases = buildNginxAcceptanceRequestCases(ports);
  for (const testCase of cases) {
    if (isInterrupted()) {
      fail("NGINX_ACCEPTANCE_INTERRUPTED", "Nginx 验收被中断。");
    }
    try {
      executeWgetRequest({
        docker,
        expectation: testCase.expectation,
        host: testCase.host,
        path: testCase.path,
        port: testCase.port,
        protocol: testCase.protocol,
        serviceName,
      });
    } catch (cause) {
      fail(
        "NGINX_ACCEPTANCE_HTTP",
        `Nginx HTTP 用例失败：${testCase.role}。`,
        cause,
      );
    }
  }
  return cases.length;
}

function parseContainerIdentity(docker, name, labelValue) {
  const result = docker.require(
    ["container", "inspect", name],
    "NGINX_ACCEPTANCE_DOCKER_SERVICE",
    "无法检查 Nginx 验收容器。",
  );
  const document = parseDockerInspect(
    result,
    "NGINX_ACCEPTANCE_DOCKER_SERVICE",
    "Nginx 验收容器身份不可解析。",
  );
  requireResourceLabel(
    document,
    labelValue,
    "NGINX_ACCEPTANCE_DOCKER_SERVICE",
  );
  return document;
}

function removeContainer(docker, name, labelValue) {
  const inspected = docker.invoke(["container", "inspect", name]);
  if (dockerNotFound(inspected, "container", name)) return;
  const document = parseDockerInspect(
    requireCommand(
      inspected,
      "NGINX_ACCEPTANCE_CLEANUP",
      "无法检查待清理的 Nginx 验收容器。",
    ),
    "NGINX_ACCEPTANCE_CLEANUP",
    "待清理的 Nginx 验收容器身份不可解析。",
  );
  requireResourceLabel(
    document,
    labelValue,
    "NGINX_ACCEPTANCE_CLEANUP",
  );
  docker.require(
    ["container", "rm", "--force", name],
    "NGINX_ACCEPTANCE_CLEANUP",
    "无法删除 Nginx 验收容器。",
  );
  const after = docker.invoke(["container", "inspect", name]);
  if (!dockerNotFound(after, "container", name)) {
    fail(
      "NGINX_ACCEPTANCE_CLEANUP",
      "Nginx 验收容器清理后仍然存在。",
    );
  }
}

function removeNetwork(docker, name, labelValue) {
  const inspected = docker.invoke(["network", "inspect", name]);
  if (dockerNotFound(inspected, "network", name)) return;
  const document = parseDockerInspect(
    requireCommand(
      inspected,
      "NGINX_ACCEPTANCE_CLEANUP",
      "无法检查待清理的 Nginx 验收网络。",
    ),
    "NGINX_ACCEPTANCE_CLEANUP",
    "待清理的 Nginx 验收网络身份不可解析。",
  );
  if (
    !isPlainRecord(document.Labels)
    || document.Labels[RESOURCE_LABEL] !== labelValue
  ) {
    fail(
      "NGINX_ACCEPTANCE_CLEANUP",
      "待清理的 Nginx 验收网络标签身份不匹配。",
    );
  }
  docker.require(
    ["network", "rm", name],
    "NGINX_ACCEPTANCE_CLEANUP",
    "无法删除 Nginx 验收网络。",
  );
  const after = docker.invoke(["network", "inspect", name]);
  if (!dockerNotFound(after, "network", name)) {
    fail(
      "NGINX_ACCEPTANCE_CLEANUP",
      "Nginx 验收网络清理后仍然存在。",
    );
  }
}

function removeTemporaryRoot(temporaryRoot, removeTemporaryDirectory) {
  removeTemporaryDirectory(temporaryRoot, {force: true, recursive: true});
  try {
    lstatSync(temporaryRoot);
    fail(
      "NGINX_ACCEPTANCE_CLEANUP",
      "Nginx 验收临时目录清理后仍然存在。",
    );
  } catch (cause) {
    if (
      cause instanceof NginxDockerAcceptanceError
      || !hasErrorCode(cause, "ENOENT")
    ) {
      throw cause;
    }
  }
}

function cleanup({
  attemptedContainers,
  attemptedNetwork,
  docker,
  labelValue,
  networkName,
  removeTemporaryDirectory,
  temporaryRoot,
}) {
  const errors = [];
  if (
    attemptedContainers.length > 0
    || attemptedNetwork
  ) {
    if (
      docker === undefined
      || typeof labelValue !== "string"
      || typeof networkName !== "string"
    ) {
      errors.push(new NginxDockerAcceptanceError(
        "NGINX_ACCEPTANCE_CLEANUP",
        "Nginx 验收资源身份未完整建立，无法安全清理。",
      ));
    } else {
      for (const name of [...attemptedContainers].reverse()) {
        try {
          removeContainer(docker, name, labelValue);
        } catch (cause) {
          errors.push(cause);
        }
      }
      if (attemptedNetwork) {
        try {
          removeNetwork(docker, networkName, labelValue);
        } catch (cause) {
          errors.push(cause);
        }
      }
    }
  }
  if (temporaryRoot !== undefined) {
    try {
      removeTemporaryRoot(temporaryRoot, removeTemporaryDirectory);
    } catch (cause) {
      errors.push(cause);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    fail(
      "NGINX_ACCEPTANCE_CLEANUP",
      "Nginx 验收存在多个清理失败。",
      new AggregateError(errors),
    );
  }
}

function assertPreflight({
  architecture,
  arguments_,
  assertExecutableIdentity,
  currentWorkingDirectory,
  environmentSource,
  nodeVersion,
  platform,
  repositoryRoot,
}) {
  if (arguments_.length !== 0) {
    fail("NGINX_ACCEPTANCE_ARGUMENTS", "Nginx 验收入口不接受参数。");
  }
  if (
    platform !== "linux"
    || architecture !== "x64"
    || nodeVersion !== EXPECTED_NODE_VERSION
  ) {
    fail(
      "NGINX_ACCEPTANCE_RUNTIME",
      "Nginx 验收入口只允许精确 Linux/amd64 主 Node 运行时。",
    );
  }
  for (const key of [
    "CI",
    "GITHUB_ACTIONS",
    "GITHUB_JOB",
    "GITHUB_WORKFLOW",
    "RUNNER_OS",
  ]) {
    if (Object.hasOwn(environmentSource, key)) {
      fail(
        "NGINX_ACCEPTANCE_AUTOMATION",
        "Nginx Docker 验收不得由统一自动化入口隐式触发。",
      );
    }
  }
  try {
    if (
      realpathSync(repositoryRoot) !== repositoryRoot
      || realpathSync(currentWorkingDirectory) !== repositoryRoot
    ) {
      throw new TypeError("repository cwd mismatch");
    }
  } catch (cause) {
    fail(
      "NGINX_ACCEPTANCE_WORKSPACE",
      "Nginx 验收必须从规范仓库根运行。",
      cause,
    );
  }
  assertExecutableIdentity(
    DOCKER_EXECUTABLE,
    "NGINX_ACCEPTANCE_DOCKER_EXECUTABLE",
  );
  assertExecutableIdentity(
    OPENSSL_EXECUTABLE,
    "NGINX_ACCEPTANCE_OPENSSL_EXECUTABLE",
  );
}

export async function runNginxDockerAcceptance({
  architecture = process.arch,
  arguments_ = process.argv.slice(2),
  assertExecutableIdentity = assertExecutable,
  createRandomBytes = randomBytes,
  createTemporaryDirectory = mkdtempSync,
  currentWorkingDirectory = process.cwd(),
  environmentSource = process.env,
  nodeVersion = process.versions.node,
  platform = process.platform,
  removeTemporaryDirectory = rmSync,
  repositoryRoot,
  signalTarget = process,
  spawnProcess = spawnSync,
} = {}) {
  if (
    typeof repositoryRoot !== "string"
    || !resolve(repositoryRoot).startsWith("/")
  ) {
    fail(
      "NGINX_ACCEPTANCE_WORKSPACE",
      "Nginx 验收缺少规范仓库根。",
    );
  }
  assertPreflight({
    architecture,
    arguments_,
    assertExecutableIdentity,
    currentWorkingDirectory,
    environmentSource,
    nodeVersion,
    platform,
    repositoryRoot,
  });

  const attemptedContainers = [];
  let attemptedNetwork = false;
  let docker;
  let interrupted = false;
  let labelValue;
  let networkName;
  let operationError;
  let result;
  let temporaryRoot;
  let sigintListenerInstalled = false;
  let sigtermListenerInstalled = false;
  const interrupt = () => {
    interrupted = true;
  };
  const requireNotInterrupted = () => {
    if (interrupted) {
      fail("NGINX_ACCEPTANCE_INTERRUPTED", "Nginx 验收被中断。");
    }
  };

  try {
    signalTarget.on("SIGINT", interrupt);
    sigintListenerInstalled = true;
    signalTarget.on("SIGTERM", interrupt);
    sigtermListenerInstalled = true;
    requireNotInterrupted();

    temporaryRoot = createTemporaryDirectory(
      join(tmpdir(), "axial-muse-nginx-acceptance-"),
    );
    chmodSync(temporaryRoot, 0o700);
    const dockerConfigRoot = resolve(temporaryRoot, "docker-config");
    mkdirSync(dockerConfigRoot, {mode: 0o700});
    chmodSync(dockerConfigRoot, 0o700);
    const commandEnvironment = childEnvironment(temporaryRoot);
    docker = createDockerClient({
      cwd: repositoryRoot,
      dockerConfigRoot,
      environment: commandEnvironment,
      spawnProcess,
    });
    labelValue = createRandomBytes(16).toString("hex");
    const prefix = `axial-muse-nginx-${labelValue}`;
    const versionName = `${prefix}-version`;
    const testName = `${prefix}-test`;
    const serviceName = `${prefix}-service`;
    networkName = `${prefix}-network`;

    const dockerVersion = requireDockerEngine(docker);
    const image = requirePinnedImage(docker);

    ensureDockerResourceAbsent(docker, "container", versionName);
    attemptedContainers.push(versionName);
    const versionResult = docker.require(
      assertPinnedNginxContainerArguments([
        "container",
        "run",
        ...commonContainerArguments({
          labelValue,
          name: versionName,
          network: "none",
        }),
        NGINX_ACCEPTANCE_IMAGE,
        "-v",
      ]),
      "NGINX_ACCEPTANCE_NGINX_VERSION",
      "无法执行固定镜像中的 Nginx 版本探针。",
    );
    if (
      versionResult.stdout !== ""
      || versionResult.stderr.trim() !==
        `nginx version: ${NGINX_ACCEPTANCE_VERSION}`
    ) {
      fail(
        "NGINX_ACCEPTANCE_NGINX_VERSION",
        "固定镜像中的 Nginx 版本不符合验收契约。",
      );
    }

    const fixture = createAcceptanceFixture({
      commandEnvironment,
      repositoryRoot,
      spawnProcess,
      temporaryRoot,
    });

    ensureDockerResourceAbsent(docker, "container", testName);
    attemptedContainers.push(testName);
    docker.require(
      assertPinnedNginxContainerArguments([
        "container",
        "run",
        ...commonContainerArguments({
          labelValue,
          name: testName,
          network: "none",
        }),
        ...mountArguments(fixture),
        NGINX_ACCEPTANCE_IMAGE,
        "-t",
        "-c",
        "/acceptance/config/nginx.conf",
      ]),
      "NGINX_ACCEPTANCE_NGINX_CONFIG",
      "真实 Nginx 配置检查失败。",
    );

    ensureDockerResourceAbsent(docker, "network", networkName);
    attemptedNetwork = true;
    docker.require(
      [
        "network",
        "create",
        "--driver",
        "bridge",
        "--internal",
        "--label",
        `${RESOURCE_LABEL}=${labelValue}`,
        networkName,
      ],
      "NGINX_ACCEPTANCE_DOCKER_NETWORK",
      "无法创建隔离 Docker 网络。",
    );
    const network = requireNetworkIdentity(docker, networkName, labelValue);

    ensureDockerResourceAbsent(docker, "container", serviceName);
    attemptedContainers.push(serviceName);
    docker.require(
      buildNginxServiceCreateArguments({
        fixture,
        labelValue,
        name: serviceName,
        network: networkName,
      }),
      "NGINX_ACCEPTANCE_DOCKER_SERVICE",
      "无法创建 Nginx 验收服务容器。",
    );
    const container = parseContainerIdentity(
      docker,
      serviceName,
      labelValue,
    );
    if (
      container.Image !== image.id
      || container.HostConfig.NetworkMode !== networkName
    ) {
      fail(
        "NGINX_ACCEPTANCE_DOCKER_SERVICE",
        "Nginx 验收服务容器没有绑定固定镜像或隔离网络。",
      );
    }
    docker.require(
      ["container", "start", serviceName],
      "NGINX_ACCEPTANCE_DOCKER_SERVICE",
      "无法启动 Nginx 验收服务容器。",
    );
    const running = parseContainerIdentity(docker, serviceName, labelValue);
    if (
      !isPlainRecord(running.State)
      || running.State.Running !== true
      || typeof running.Id !== "string"
      || !/^[0-9a-f]{64}$/u.test(running.Id)
      || running.Image !== image.id
      || running.ImageManifestDescriptor?.digest !==
        NGINX_ACCEPTANCE_MANIFEST_DIGEST
      || running.ImageManifestDescriptor?.platform?.os !== "linux"
      || running.ImageManifestDescriptor?.platform?.architecture !== "amd64"
    ) {
      fail(
        "NGINX_ACCEPTANCE_DOCKER_SERVICE",
        "Nginx 验收服务容器未进入运行态。",
      );
    }
    const endpoint = extractInternalServiceEndpoint(running, networkName);
    if (endpoint.networkId !== network.Id) {
      fail(
        "NGINX_ACCEPTANCE_DOCKER_NETWORK",
        "Nginx 验收容器网络身份在启动时发生漂移。",
      );
    }
    requireExclusiveNetworkMember({
      address: endpoint.address,
      containerId: running.Id,
      docker,
      labelValue,
      networkId: network.Id,
      networkName,
      serviceName,
    });
    const assertionCount = runHttpAcceptance({
      docker,
      isInterrupted: () => interrupted,
      ports: endpoint.ports,
      serviceName,
    });
    if (assertionCount !== NGINX_ACCEPTANCE_HTTP_ASSERTION_COUNT) {
      fail(
        "NGINX_ACCEPTANCE_HTTP_MATRIX",
        "Nginx HTTP 验收没有执行固定数量的断言。",
      );
    }
    requireNotInterrupted();
    const afterAcceptance = parseContainerIdentity(
      docker,
      serviceName,
      labelValue,
    );
    if (
      !isPlainRecord(afterAcceptance.State)
      || afterAcceptance.State.Running !== true
      || afterAcceptance.Id !== running.Id
      || afterAcceptance.Image !== image.id
      || afterAcceptance.ImageManifestDescriptor?.digest !==
        NGINX_ACCEPTANCE_MANIFEST_DIGEST
      || afterAcceptance.ImageManifestDescriptor?.platform?.os !== "linux"
      || afterAcceptance.ImageManifestDescriptor?.platform?.architecture !==
        "amd64"
    ) {
      fail(
        "NGINX_ACCEPTANCE_DOCKER_SERVICE",
        "Nginx 验收容器身份在 HTTP 验收期间发生漂移。",
      );
    }
    const afterEndpoint = extractInternalServiceEndpoint(
      afterAcceptance,
      networkName,
    );
    if (
      afterEndpoint.networkId !== network.Id
      || afterEndpoint.networkId !== endpoint.networkId
      || afterEndpoint.address !== endpoint.address
    ) {
      fail(
        "NGINX_ACCEPTANCE_DOCKER_NETWORK",
        "Nginx 验收容器网络身份在 HTTP 验收期间发生漂移。",
      );
    }
    requireExclusiveNetworkMember({
      address: endpoint.address,
      containerId: running.Id,
      docker,
      labelValue,
      networkId: network.Id,
      networkName,
      serviceName,
    });
    requireNotInterrupted();
    result = Object.freeze({
      assertionCount,
      canonicalSlashRuleCount: fixture.artifacts.canonicalSlashRuleCount,
      dockerVersion,
      imageDigest: NGINX_ACCEPTANCE_IMAGE,
      imageId: image.id,
      nginxVersion: NGINX_ACCEPTANCE_VERSION,
      platform: NGINX_ACCEPTANCE_PLATFORM,
      registeredRuleCount: fixture.artifacts.registeredRuleCount,
    });
  } catch (cause) {
    operationError = cause;
  }

  let cleanupError;
  try {
    cleanup({
      attemptedContainers,
      attemptedNetwork,
      docker,
      labelValue,
      networkName,
      removeTemporaryDirectory,
      temporaryRoot,
    });
  } catch (cause) {
    cleanupError = cause;
  } finally {
    if (sigintListenerInstalled) {
      signalTarget.removeListener("SIGINT", interrupt);
    }
    if (sigtermListenerInstalled) {
      signalTarget.removeListener("SIGTERM", interrupt);
    }
  }
  if (interrupted && operationError === undefined) {
    operationError = new NginxDockerAcceptanceError(
      "NGINX_ACCEPTANCE_INTERRUPTED",
      "Nginx 验收被中断。",
    );
  }
  if (operationError !== undefined && cleanupError !== undefined) {
    fail(
      "NGINX_ACCEPTANCE_OPERATION_AND_CLEANUP",
      "Nginx 验收操作与清理均失败。",
      new AggregateError([operationError, cleanupError]),
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  if (result === undefined) {
    fail("NGINX_ACCEPTANCE_INTERNAL", "Nginx 验收没有形成结果。");
  }
  return result;
}

export function formatNginxDockerAcceptanceError(error) {
  if (error instanceof NginxDockerAcceptanceError) {
    return `[${error.code}] ${error.message}`;
  }
  return "[NGINX_ACCEPTANCE_INTERNAL] Nginx Docker 验收发生未分类错误。";
}
