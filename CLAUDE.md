# CLAUDE.md

本文件为 Claude Code（claude.ai/code）提供本仓库的补充指引。**项目级最高规范是 [AGENTS.md](AGENTS.md)**，Claude Code 与 Codex 共同遵守。本文件不新增规范、不复制设计结论，只补 Claude Code 专属的工具链事实与坑点；与 AGENTS.md 冲突时以 AGENTS.md 为准。

## 上手顺序

1. 读 [AGENTS.md](AGENTS.md)：指令优先级、用户决策门禁、通用约束。优先级为系统/开发者/用户的显式指令 > `AGENTS.md` > `docs/` 设计 > `codex-rules/` 操作规则。
2. 读 [docs/README.md](docs/README.md) 的“当前阶段”和任务相关设计文档。**阶段、范围、非目标和技术栈只从这里获取，本文件不维护副本**——本文件此前正因维护了一份阶段副本而与 `docs/` 脱节。
3. 变更仓库内容时读 [codex-workflow.md](codex-rules/rules/codex-workflow.md)，再按 [global-AGENTS.md](codex-rules/global-AGENTS.md) 的路由表**只加载命中任务类型的主题规则**；禁止批量加载整个 `codex-rules/`。
4. [known-issues.md](codex-rules/known-issues.md) **仅**在任务涉及 `scripts/dev/`、PowerShell、跨机预览或本地忽略配置时读取，它不是通用 bug 台账。

## 用户决策门禁（Claude Code 最容易越界的地方）

完整五条在 [AGENTS.md](AGENTS.md)，这里只点出工具最常违反的：

- **推荐不等于授权。** 不得用默认方案、保守方案、行业惯例或“可否决判断”替代用户确认。
- **确认前不得动手。** 不改依赖该决定的文档、代码、配置、公开内容或基础设施，不 commit、push、创建或合并 PR，不操作服务器、DNS、云资源。
- **先查证再提问。** 能从仓库、文档、配置、运行环境和工具查到的事实，不让用户猜。
- **确认后先复述**选择、授权范围、影响和验证方式，写入设计文档或决策记录，再实施。

技术栈、信息架构、视觉方向、公开文案与内容范围、数据与隐私、外部服务、费用、域名与部署、破坏性操作和 Git 发布流程均属于典型用户决策事项。

## 会阻断动手的门禁

- [open-decisions.md](docs/architecture/open-decisions.md) 的“上线前必须核验”是硬门禁，其中的未决项会阻断页面实现和生产配置（写作本文件时为 OD-014 主站设计评审、OD-015 Docusaurus 内容组织）。**以该文件当时的状态为准，不要凭本文件判断门禁是否已解除。**
- 新增任何 npm 包、前端依赖或会进入浏览器产物的资源前，先读 `open-decisions.md` 里的 D-052 开源依赖分层准入；许可证不合规的不得链接或编译进主站产物，且该政策不自动批准任何具体包或版本。
- 引入第三方服务、浏览器外部请求、用户数据采集、评论、订阅或分析前，先读 [content-product-rules.md](codex-rules/rules/content-product-rules.md) 和 [security-privacy.md](codex-rules/rules/security-privacy.md)。

## 架构

目录职责（现状见 [architecture/overview.md](docs/architecture/overview.md)，目标架构见 [main-site-target-architecture.md](docs/architecture/main-site-target-architecture.md)）：

- `docs/`：定位、架构、内容模型、产品服务演进和契约的真相源，含 `docs/projects/` 下各项目展示设计。
- `public/`：当前静态站点入口与资源（`index.html` + `styles.css`）。
- `scripts/quality/`：CI 与本地共用的质量门禁（Node.js ESM，零第三方依赖）。
- `scripts/dev/`：跨机协同预览工作流脚本，设计见 [dev-workflow.md](docs/architecture/dev-workflow.md)。
- `codex-rules/`：Agent 执行任务的操作规范，**不替代** `docs/` 设计真相源。
- `.githooks/`：本地提交门禁；`.github/`：CI、CODEOWNERS 和 PR 模板。

## 常用命令

```bash
# 全量质量门禁（与 CI 对齐，五项按序串联）
npm run quality

# 单项门禁
npm run check:js          # 质量脚本自身语法自检（node --check），quality 链第一环
npm run check:docs        # Markdown 内部链接 + docs/README 索引完整性
npm run check:contracts   # 契约词表：禁用旧名回潮 + 契约词跨层误用
npm run check:secrets     # 常见密钥形态扫描
npm run check:site        # 静态站点入口和资源引用

# 不在 quality 链路里，需要本机装 Java 并设置 PUML_JAR 才能跑
PUML_JAR=/path/to/plantuml.jar npm run check:diagrams   # 编译校验所有 Markdown 里的 plantuml 图表
PUML_JAR=/path/to/plantuml.jar npm run gen:diagrams     # 改完图表源码后，重新渲染 docs/diagrams/ 下的 SVG

# 临时手动预览当前静态入口
python3 -m http.server -d public 8000
```

要求 Node ≥ 22，`quality` 全部走 Node.js 内置能力、不依赖第三方 npm 包。跨机协同预览走 `scripts/dev/preview.sh`（固定 8088 端口），与上面这条临时 8000 预览是两条独立链路，见 [dev-workflow.md](docs/architecture/dev-workflow.md)。

## 质量门禁现状

`npm run quality` 按 `check:js` → `check:docs` → `check:contracts` → `check:secrets` → `check:site` 串联，任一失败即 CI 失败（`.github/workflows/ci.yml` 在 PR、推送 `main`/`dev` 时于 Ubuntu 与 Windows 上运行同一命令）：

- `check:docs`（`check-markdown.mjs`）：校验所有 `*.md` 的内部链接不断链、不逃逸仓库；并强制 **`docs/` 下每个 `.md` 都被 `docs/README.md` 索引**。新增 `docs/` 文档后必须补索引，否则门禁失败。
- `check:contracts`（`check-contracts.mjs`）：真相源是 [contract-terms.json](docs/contracts/contract-terms.json)（稳定契约名/枚举）与 [contract-rules.json](docs/contracts/contract-rules.json)（`forbidden_terms` 防旧名回潮、`scoped_terms` 防契约词跨层误用）。扫描范围是 `docs` / `public` / `scripts` / `codex-rules` / `.github` 递归，**外加仓库根级文件只扫一层**（`include_root_files`）——所以 `AGENTS.md`、本文件、`README.md`、`CONTRIBUTING.md`、`package.json` 都受契约门禁约束，写措辞时要对齐契约词。根目录不递归是刻意的：`.mypy_cache`、未来的 `.docusaurus` 这类本地工具缓存靠自带的嵌套 `.gitignore` 对 git 隐身，但扫描器走文件系统、不读 `.gitignore`，递归会把它们卷进门禁并让扫描范围随各人机器的残留而变；只扫一层则天然排除所有目录，且新增根级文件自动纳入、无需登记。注意 `forbidden_terms` 里 `match: word` 的条目按词边界匹配，`AxialMuseWebsite` 不会命中品牌名规则；`scoped_terms` 把受限词钉在 `open-decisions` / `glossary` / `content-roadmap` / `contracts/` / `codex-rules/`，其它路径写了就失败——本文件也在扫描范围内，因此这里不便直接举例写出该词，见 `contract-rules.json`。改契约名先动这两个 JSON。
- `check:secrets`（`check-secrets.mjs`）：扫描常见密钥形态，防止 token/密钥误入库。
- `check:site`（`check-static-site.mjs`）：读取 [site-checks.json](docs/contracts/site-checks.json) 配置的 `entryFile` 和 `requiredSnippets`，校验入口文件含必需结构片段且引用的本地资源都存在；入口文件尚不存在时打印提示并跳过，不报错。改首页结构或锚点时同步改 `site-checks.json`。

本地提交前由 `.githooks/pre-commit` 自动跑 `npm run quality`、`.githooks/commit-msg` 校验提交信息格式（首次克隆后执行 `git config core.hooksPath .githooks` 启用）。它们是 CI 的本地镜像，别绕过。

另有两道独立于 `quality` 之外、围绕 PlantUML 图表的机制，共享 `scripts/quality/lib/plantuml.mjs` 的提取/编译逻辑：

- `check:diagrams`：扫描所有 Markdown 里的 ` ```plantuml ` 代码块并用 `java -jar $PUML_JAR` 真实编译，仓库里一个块都没有时直接跳过；有块但没设 `PUML_JAR` 则报错退出（不静默跳过）。只认编译退出码，不比较字节内容。
- `gen:diagrams`：把每个 plantuml 块的编译结果写入紧跟其后的 `![](path.svg)` 指向的文件。这是**本地生成器、不是门禁**——CI 不校验已提交 SVG 与源码字节一致（不同机器的 JVM 字体度量会让同一份源码渲染出不同字节）。真相源是 Markdown 里的 plantuml 源码，由 `check:diagrams` 保证能编译；SVG 只是给 GitHub 这类不渲染内嵌 plantuml 的平台看的产物，改完源码本地跑一次 `gen:diagrams` 刷新并提交即可。

CI 里由独立的 `diagrams` job（只跑 `ubuntu-latest`）下载校验过 SHA256 的 PlantUML 官方 release jar 后执行 `check:diagrams`，因此本地贡献者不装 Java 也能跑主 `quality` 门禁。

## 工程约定

- 语言：对话与 `docs/` 用简体中文；代码注释中文为主，标准英文术语/协议名/API 名保留原文；用户可见 UI 文案默认简体中文。详见 [language.md](codex-rules/rules/language.md)。
- 品牌名统一写作 `Axial Muse`（带空格），`AxialMuseWebsite` 仅作仓库/项目标识；定位表述用“技术分享”。这些命名在上述五个扫描根内由契约门禁强制。
- 分支：`main` 稳定不直接提交，`dev` 开发主干，特性分支 `feature/描述` / `bugfix/描述`。提交信息中英双语、英文在前，格式 `<type>(<scope>): <English 主题> / <中文主题>`，不带 Co-Authored-By。
- `.env`、`node_modules/`、构建产物、日志不进 Git（见 `.gitignore`）。
- UI 改动必须做实际渲染或截图验证；纯静态页面至少检查入口文件、资源引用和关键链接。
- 每次任务结束更新 [docs/progress.md](docs/progress.md)（时间戳/主题/完成/遗留）。涉及 `scripts/dev/`、跨机预览或本地配置的坑点，解决后追加到 [known-issues.md](codex-rules/known-issues.md)；其它类型的问题不要往那里堆。
- push 到 `main`/`dev` 或合并 PR 后，必须主动观察 `.github/workflows/ci.yml` 的结果（`gh pr checks <PR号> --watch` 或 `gh run watch`），失败要定位、修复、重跑 `npm run quality` 验证后再推送，直到转绿；不允许在 CI 红色或状态未知时汇报任务完成。
