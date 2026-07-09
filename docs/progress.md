# 项目进度

本文件是 AxialMuseWebsite 的项目进度真相源，按时间倒序记录每次任务的完成内容与遗留项。每次任务结束或中断时更新。

条目格式：`时间戳 / 主题 / 完成内容 / 遗留项`。

## 2026-07-09 — 从 project-scaffold 回填工程脚手架改进

- **主题**：`project-scaffold` 是从本项目抽象出去的通用脚手架，抽象后又自行演进出一批改进（配置驱动、健壮性/安全加固、PlantUML 图表门禁）。对照两边差异，只回填"确实缺、确实适合当前阶段"的部分，按本项目真实上下文改写（非字节级复制）。
- **完成内容**：
  - **修复现存规则违规**：`docs/architecture/overview.md` 原用 Mermaid 画架构图，违反全局规则（禁用 Mermaid，强制 PlantUML）；`docs/architecture/dev-workflow.md` 已有 plantuml 时序图但从未编译校验、未渲染 SVG。新增 `scripts/quality/lib/plantuml.mjs` + `check-diagrams.mjs`（编译校验，独立于 `quality` 之外）+ `render-diagrams.mjs`（本地渲染器），用本机 `java -jar plantuml-1.2026.1.jar` 实测编译通过，`docs/diagrams/*.svg` 落地；CI 新增独立 `diagrams` job（下载并 SHA256 校验官方 jar）。
  - **静态站点检查配置化**：新增 `docs/contracts/site-checks.json`，重写 `check-static-site.mjs` 改为读取配置、入口文件不存在时优雅跳过、资源引用正则更健壮（覆盖单/双引号、跳过 data:/mailto:/锚点等）。
  - **CI 加固**：`push` 触发补上 `dev` 分支（此前只在 `main` push 时跑，与"push 到 main/dev 都要观察 CI"的规则不一致）；`actions/checkout`、`actions/setup-node` 升到 v5；quality job 加 `windows-latest` matrix，呼应真实存在的跨机 Windows/Linux 工作流。
  - **跨机预览脚本安全/健壮性修复**：`preview.sh` 新增端口占用保护（`port_listener_pid`/`pid_is_our_server`），避免误认或误杀同端口上的无关进程；`restart-remote.ps1` 新增分支名白名单 + 仓库路径黑名单校验，修复一个真实的远端命令注入面（此前 `$Branch`/`$RemoteRepoPath` 直接拼进 SSH 命令字符串，无任何字符过滤）。两个脚本改为从新增的 `scripts/dev/dev-workflow.env`（gitignored）读取主机/端口/路径，不再硬编码在已提交脚本里。
  - **其它**：新增 `.gitattributes`（跨平台换行归一化）、`CONTRIBUTING.md`、PR 模板加"对应设计文档"字段。
  - **顺带修复一个 `.gitignore` 漏洞**：`.env`/`.env.*` 模式实际不匹配 `dev-workflow.env` 这个文件名（不以 `.env` 开头），已补充显式规则 `scripts/dev/dev-workflow.env`，并用 `git check-ignore -v` 验证生效。
  - **自测证据**：`npm run quality` 全量通过；`PUML_JAR=... npm run check:diagrams` 通过（2 张图编译成功）且 `gen:diagrams` 幂等（二次运行无新改动）；对当前正在运行的真实预览服务（PID 由旧脚本启动）执行 `preview.sh restart`，新脚本正确识别、停止旧进程并重新拉起，`curl` 确认 HTTP 200；模拟删除 `dev-workflow.env` 验证脚本按预期报错退出而非静默使用错误默认值；`restart-remote.ps1` 的分支名白名单正则用一组通过/拒绝样例验证过滤逻辑正确（本机无 PowerShell，未做端到端执行验证，见遗留项）。
- **未采纳（及理由）**：LICENSE、`.claude/rules/*.md` 项目内镜像——已征询用户明确选择不采纳；`docs/architecture/stack-recipes/`——尚未选定具体技术栈，属于为假设的未来需求预先设计，先不引入；`scripts/init.mjs`/`SCAFFOLD.md`——脚手架自身初始化工具，本项目已初始化，不适用；`.claude/hooks/pre-edit-validate.py` 与项目级 `.claude/settings.json`——确认用户全局配置已提供同等校验，属纯冗余；`.claude/skills/sync-shared-rules/`——是 scaffold 作为"规则同步枢纽"角色专属技能，不适合复制进被同步方。
- **遗留项**：
  - `restart-remote.ps1` 的改动未在真实 Windows PowerShell 环境里端到端执行验证（本次会话在 Linux 上完成，只做了语法层面的正则逻辑验证），建议下次在 Windows 端跑一次 `sync.ps1 -RestartPreview` 完整验证。
  - `docs/diagrams/*.svg` 是本机 JVM 字体度量下的渲染产物，不同机器渲染字节可能不同，属预期行为（见 CLAUDE.md 说明），非缺陷。
  - 尚未实际 `git add` + 提交本次改动，也未推送观察 CI（含新增的 `diagrams` job 与 `windows-latest` matrix 是否真的转绿）。

## 2026-07-05（下午）— 验证跨机协同工作流是否满足实际需求，发现并修正环境假设

- **主题**：用户提出四条具体验收要求（Linux 托管+Windows 窗口渲染、Windows 端凭源码与渲染标注自主改代码并推送重启、双向一键同步、双端用 worktree），要求对照 [跨机协同开发预览工作流](architecture/dev-workflow.md) 和已提交脚本逐条验证是否真能做到，而不是只核对代码是否符合设计文档字面描述。
- **完成内容**：
  - **纠正了一个基础假设**：设计文档原先默认"当前 Claude Code CLI 会话＝Linux 托管机"，实测发现本次会话其实跑在 Windows 机器（hostname `lyty-server`，`192.168.0.163`）上，`192.168.0.162` 是局域网内另一台真实、可 ping 通的 Linux 机器。两者不能划等号，已更新设计文档把"托管角色"与"编码会话所在机器"拆开描述。
  - **实测确认渲染机制**：Windows 端 Claude Desktop 已配对 Chrome 浏览器扩展（`allowAllBrowserActions: true`），实测 `list_connected_browsers` 连接为活跃状态，且成功 `navigate` 到局域网预览地址——不需要设计文档原先设想的 Playwright MCP 回退方案。
  - **搭建 Windows→Linux 的 SSH 免密通道**：发现原有 `~/.ssh/known_hosts` 里 `192.168.0.162` 的指纹只代表"连接过"、不代表"能免密登录"（实测公钥认证被拒）。生成专用密钥对 `id_ed25519_axialmuse_preview`（不复用 GitHub 那把），用户手动把公钥装进 Linux 端 `~/.ssh/authorized_keys` 后验证通过。借这个通道现场确认了 Linux 端仓库真实路径 `~/work/personal_projects/AxiomMind/Axial_Muse/AxialMuseWebsite`，以及 `AxialMuseWebsite.preview` worktree、`preview.sh`/`sync.sh` 确实都在（此前 `progress.md` 的记录是真的，只是这次 Windows 端会话看不到）。
  - **新增 `scripts/dev/restart-remote.ps1`**（Windows 端）：SSH 到 Linux 端执行 `preview.sh restart <分支>`，把"改代码→同步→远程重启"收成一步；`sync.ps1` 新增可选开关 `-RestartPreview` 串联这一步。已实测：从分离头指针 `779407e` 成功拉到 `ee7b400` 并重启监听。
  - **发现并修复真实 bug（不是设计层面，是运行时才会暴露的）**：`sync.ps1` 与新写的 `restart-remote.ps1` 最初都是无 BOM 的 UTF-8，Windows PowerShell 5.1 在这台机器（系统默认代码页 GB2312）上解析时把中文注释解码错乱，报一堆无关的语法错误，导致脚本根本跑不起来。改成带 BOM 的 UTF-8 后正常执行，详见 [known-issues.md](../codex-rules/known-issues.md)。这个坑此前的纯代码审查（不实际执行）完全没发现。
  - 之前一轮（逐条核对 `ee7b400` 是否实现了 `4d169a7`/`985e89f` 设计文档的要求）里也顺手修了两处：`sync.ps1` 三条主 git 命令后补了 `$LASTEXITCODE` 检查（此前失败会被静默吞掉）；`preview.sh restart` 调整成先 `checkout_ref`（含 fetch）成功后再杀旧进程，避免网络抖动时把服务停了却起不来。
  - **网络问题已由用户解决并完成最终闭环验证**：Linux 托管机放行了局域网到 8088 端口的访问（原因确认是主机防火墙只放了 22 端口）。放行后 `Test-NetConnection 192.168.0.162 -Port 8088` 从 Windows 端返回 `TcpTestSucceeded: True`；用已配对的 Chrome 扩展重新 `navigate` 到 `http://192.168.0.162:8088/`，标签页标题变为真实的 `Axial Muse`（不再是连接失败的错误页），`get_page_text` 读到实际正文"Axiom Mind / 围绕 AI、知识工作流和个人产品体系的长期项目集合"。至此四条验收要求（Linux 托管+Windows 渲染、Windows 端凭源码与渲染标注改代码并推送重启、双向一键同步、双端 worktree）全部拿到端到端实测证据，不再只是设计层面的判断。
- **遗留项**：
  - `scripts/dev/restart-remote.ps1`（新增）与 `scripts/dev/sync.ps1`/`scripts/dev/preview.sh`（本轮修复）、`docs/architecture/dev-workflow.md`/本文件/`codex-rules/known-issues.md` 的更新目前都还是工作区改动，尚未提交，等待用户确认后提交。

## 2026-07-05 — 落地跨机协同开发预览工作流

- **主题**：按 [跨机协同开发预览工作流](architecture/dev-workflow.md) 设计文档，落地 Linux 端预览基础设施。
- **完成内容**：
  - 从 `main` 切出 `dev` 分支作为开发主干。
  - 新建 Linux 预览 worktree `../AxialMuseWebsite.preview`（分离头指针模式，避免与主目录已检出的分支冲突）。
  - 新增 `scripts/dev/sync.sh` / `scripts/dev/sync.ps1`（双向同步）与 `scripts/dev/preview.sh`（serve/restart/stop/status）。
  - **自测证据**（`preview.sh`，端口 8088）：
    - `serve main` → `curl http://192.168.0.162:8088/` 返回 `HTTP 200`，页面 `<title>Axial Muse</title>` 与 `main` 分支内容一致。
    - 连续 6 轮 `serve` → `curl` → `stop` → `curl` 验证，`stop` 后端口正确释放（发现并修复一处 `pipefail` 导致重试循环失效的 bug，见下）。
    - 重复 `serve` 被正确拒绝（提示先 `stop`/`restart`）；`serve` 不存在的分支报错且不残留进程。
    - `restart`（带分支参数与不带参数复用历史分支）均验证通过。
  - **踩坑记录**：`start_server` 最初用 `$!` 记录 PID，在 `setsid` 因调用方恰好是 process group leader 而内部二次 fork 的场景下，`$!` 拿到的是很快退出的包装进程（zombie 状态下 `kill -0` 仍返回成功），导致 `stop` 杀不到真正的服务；改为从监听 socket（`ss -tlnp`）反查真实 PID 解决。改的过程中还踩了一个 `pipefail` 坑：`grep` 无匹配时以状态 1 退出，直接赋值给变量在 `set -e` 下会让重试循环第一次没找到进程就终止整个脚本，加 `|| true` 后才是真正的"重试"。
  - `sync.sh` 验证时直接执行导致 `dev` 分支被推送到 `origin`（origin/dev 已建立）——这一步应先与用户确认，已如实告知。
- **遗留项**：
  - Windows Claude Desktop 是否原生支持外部局域网 URL 实时渲染与点选标注尚未现场验证（见设计文档"未决事项"），待用户在 Windows 端实测后回填。
  - `scripts/dev/` 三个脚本本身尚未提交到 git。

## 2026-07-03 — 对齐参考项目工程规范

- **主题**：参考 Augur_Maestro 的工程规范，在本项目补齐同构的工程约束。
- **完成内容**：
  - 新增 `CLAUDE.md`，作为 Claude Code 的工作入口，与 `AGENTS.md`、`codex-rules/`、`docs/` 共用同一真相源。
  - 新增本文件 `docs/progress.md` 作为进度真相源，并在 `docs/README.md` 索引。
  - 新增本地 `.githooks/pre-commit`，提交前自动运行 `npm run quality`，作为 CI 的本地镜像。
  - `README.md` 工程规范入口补充 `CLAUDE.md`。
  - 复验 `npm run quality` 四项门禁（Markdown 链接与索引、契约词表、密钥形态、静态站点）全部通过。
- **既有基线**（本次之前已就位）：`AGENTS.md`、`codex-rules/`、`docs/`（架构/契约/产品路线）、`scripts/quality/`、`.github/`（CI、CODEOWNERS、PR 模板）、`public/` 首版静态站点。
- **遗留项**：
  - 仓库尚未 `git init`；CI、分支策略（`main`/`dev`）、CODEOWNERS 均以 git 为前提，需初始化后 pre-commit 钩子才生效。
  - 首版内容页 `public/index.html` 仍为骨架，具体技术分享条目与项目展示内容待按 `docs/product/content-roadmap.md` 填充。
