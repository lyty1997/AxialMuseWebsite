# 质量门禁操作规范

门禁的能力清单与验收要求属于设计事实，真相源是[自动化维护与运行手册](../../docs/operations/maintenance.md)的“Pull Request 门禁”。本文件只记录执行层的命令、边界和坑点，不复制设计结论。

正常入口要求 Node 与仓库 `.nvmrc` 精确一致；最低兼容入口要求 Node 等于 `package.json#engines.node` 下界。`quality` 全部走 Node.js 内置能力，不依赖第三方包；需要调用包管理器脚本时必须经过 E-010 隔离入口。

## 命令

```bash
node scripts/quality/run-isolated-npm.mjs run-script quality

# 单项只读检查直接运行仓库内零依赖 Node 入口
node scripts/quality/check-javascript.mjs
node scripts/quality/check-npm-isolation.mjs
node scripts/quality/check-markdown.mjs
node scripts/quality/check-contracts.mjs
node scripts/quality/check-secrets.mjs
node scripts/quality/check-static-site.mjs
node --test tests/build/run-isolated-npm.test.mjs

# 不在 quality 链路里：需本机装 Java 并设置 PUML_JAR 才能跑
PUML_JAR=/path/to/plantuml.jar node scripts/quality/check-diagrams.mjs
PUML_JAR=/path/to/plantuml.jar node scripts/quality/render-diagrams.mjs

python3 -m http.server -d public 8000                   # 临时手动预览当前静态入口
```

在获准运行本站 Node.js 的 Linux 工作区，本地提交前由 `.githooks/pre-commit` 自动通过 E-010 隔离入口运行完整 `quality` 负载，`.githooks/commit-msg` 校验提交信息格式；首次克隆后执行一次 `git config core.hooksPath .githooks` 启用，不能绕过。Ubuntu CI 在合入与发布前执行统一验证。

跨机协同预览走 `scripts/dev/preview.sh`（固定 8088 端口），与上面的临时 8000 预览是两条独立链路，见[跨机协同开发预览工作流](../../docs/architecture/dev-workflow.md)。

## 各门禁的执行边界

- **check:docs**：校验所有 `*.md` 的内部链接不断链、不逃逸仓库，并强制 `docs/` 下每个 `.md` 都被 `docs/README.md` 索引。在 `docs/` 新增文档后必须补索引，否则门禁失败；`codex-rules/` 下的文件不受索引要求约束。
- **check:contracts**：真相源是 `docs/contracts/contract-terms.json`（稳定契约名与枚举）和 `docs/contracts/contract-rules.json`（`forbidden_terms` 防旧名回潮、`scoped_terms` 防契约词跨层误用）。改契约名先动这两个 JSON，再改引用处。
- **check:npm-isolation**：校验项目 npm 配置、Node/npm 双端点、隔离环境、manifest/lockfile 来源、受控 profile、CI/hook 接线和操作文档旁路；真实包管理器进程只能由隔离 runner 派生并在预检通过后启动。
- **check:site**：读取 `docs/contracts/site-checks.json` 配置的 `entryFile` 与 `requiredSnippets`，校验入口文件含必需结构片段且引用的本地资源都存在。入口文件尚不存在时打印提示并跳过，不报错。改首页结构或锚点时必须同步改 `site-checks.json`。
- **check:diagrams**：扫描所有 Markdown 里的 ` ```plantuml ` 块并用 `java -jar $PUML_JAR` 真实编译，只认编译退出码、不比较字节内容。仓库里一个块都没有时直接跳过；有块但没设 `PUML_JAR` 则报错退出，不静默跳过。CI 由独立的 `diagrams` job（只跑 `ubuntu-latest`）下载校验过 SHA256 的官方 jar 后执行，因此本地不装 Java 也能跑主 `quality`。

## 坑点

- **契约词是词边界匹配**：`forbidden_terms` 里 `match: word` 的条目按词边界匹配，因此仓库标识 `AxialMuseWebsite` 不会命中品牌名规则；品牌名本身必须写成带空格的 `Axial Muse`，无空格写法在任何路径都会被拦截。
- **写门禁文档时会拦到自己**：描述某条规则时若把被禁词或越界的受限词原样写进正文，`check:contracts` 会当场判违规——它不区分“违规”与“在讲解违规”。举例时改用描述性说法，或指向 `contract-rules.json`。
- **`scoped_terms` 按路径放行**：受限词只允许出现在 `open-decisions` / `glossary` / `content-roadmap` / `contracts/` / `codex-rules/`，其它路径写了就失败。本文件位于 `codex-rules/`，在放行范围内。
- **根目录只扫一层**：`scan.include_root_files` 让 `AGENTS.md`、`CLAUDE.md`、`README.md`、`CONTRIBUTING.md`、`package.json` 等根级文件纳入契约门禁，但根目录**不递归**。原因是 `.mypy_cache`、未来的 `.docusaurus` 这类本地工具缓存靠自带的嵌套 `.gitignore` 对 git 隐身，而扫描器走文件系统、不读 `.gitignore`；递归会把它们卷进门禁，让扫描范围随各人机器上的残留而变。只扫一层则目录天然进不来，无需维护排除名单，新增根级文件也能自动纳入。改这里前先想清楚是不是又在建黑名单。
- **`gen:diagrams` 是本地生成器，不是门禁**：它把每个 plantuml 块的编译结果写入紧跟其后的 `![](path.svg)` 指向的文件。CI 不校验已提交 SVG 与源码字节一致——不同机器的 JVM 字体度量会让同一份源码渲染出不同字节，字节相等门禁无法跨机器稳定通过。真相源是 Markdown 里的 plantuml 源码，由 `check:diagrams` 保证能编译；SVG 只是给不渲染内嵌 plantuml 的平台（如 GitHub）看的产物。改完源码本地跑一次 `gen:diagrams` 刷新并提交即可。
