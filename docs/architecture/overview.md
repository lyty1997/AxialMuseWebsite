# 架构概览

状态：active  
最近更新：2026-07-16
适用范围：M0 静态网站、工程规范与生产发布基线

## 目标架构更新

用户已确认主站使用 Git + Docusaurus 静态构建，并采用“静态主站 + 中央身份服务 + 独立评论服务 + 各项目独立服务”的演进方向。D-053 进一步固定 Docusaurus 官方静态能力、现有 PlantUML、Nginx/Certbot、GitHub Actions/TAT、Ubuntu/systemd 原生运维和 CI 门禁能力类别；D-054 固定项目介绍与技术文章共用单一 docs 内容实例、分别使用各自侧栏且首版不启用 blog；D-055 固定领域内容模型是唯一可编辑真相源，Docusaurus 元数据只在构建期单向投影；D-056 固定技术文章通过官方 `markdown.parseFrontMatter` 调用本地纯投影函数；D-057 固定相对 docs 内容根的 `writing/` 子树是唯一技术文章类型边界。完整的已确认边界和待决策项见[主站目标架构](main-site-target-architecture.md)。

本文其余部分记录当前仓库实现和 2026-07-13 形成的 M0 生产基线。凡涉及手工维护 `public/index.html`、零框架或推迟静态站点生成器的内容，均已被 D-028、D-029、D-051 先后替代；在 Docusaurus 迁移完成前，它们只描述当前状态，不代表目标实现。

## 目标

AxialMuseWebsite 的首版目标是建立一个可维护的个人技术分享网站，为每个可体验项目提供独立子域名入口，并提前保留向产品服务、技术文章和讨论入口演进的结构空间。

## 架构决策摘要

| 决策域 | M0 选择 | 设计依据 |
|---|---|---|
| 页面技术 | 当前为手写静态骨架；目标为 Docusaurus 单一 docs 内容实例静态构建 | Git 内容发布、React 技术栈、多页面演进、项目/文章双侧栏、领域字段单向投影方向、技术文章适配执行点和 `writing/` 类型边界已经确认；内容根物理路径、逐字段投影、项目适配、实例配置、构建契约与可选客户端策略尚未决定 |
| 内容事实 | Git 审核；文章默认 Markdown、MDX 受控例外，核心字段、组织基数与 `classification` 唯一分组已确认 | 公开内容保持可追溯，构建产物不作为编辑源；项目/模块/主题注册表仍需确认 |
| 当前质量运行时 | Node.js 22 ESM | 只描述现有零第三方依赖检查；Docusaurus 与 Node.js 的目标版本仍待依赖契约确认 |
| 图表 | 现有 PlantUML 源码编译为静态 SVG | 保留构建期图表流程，不增加浏览器端渲染或 Docusaurus 运行时插件 |
| 质量与供应链 | D-053 已固定必需能力类别 | 当前脚本尚未完整覆盖 Docusaurus；具体工具、格式、阈值和例外流程仍由构建发布契约确定 |
| 生产服务 | Ubuntu 24.04 LTS + Nginx + Certbot（ACME HTTP-01）+ systemd/logrotate | 直接提供静态产物和原生运维，不运行主站应用后端或数据库 |
| 发布 | GitHub Actions -> CAM -> TAT 固定命令 | 只发布 `main` 精确 SHA，不向自动化开放任意 SSH 命令 |
| 数据与隐私 | 无应用数据层、无 Cookie、无第三方运行时请求 | M0 没有已确认的数据收集需求 |

当前有效的选择、取舍和实施门禁见[主站目标架构](main-site-target-architecture.md)。现有[M0 主站实现 Spec](../product/m0-main-site-spec.md)基于已废止的原生 HTML 方案，需要适配 Docusaurus 后重新评审；新版 Spec 确认前不得进入页面实现。

## 当前实现

```plantuml
@startuml
package "访问者" {
  [浏览器] as Browser
}
package "public/" {
  [index.html] as Index
  [styles.css] as Styles
}
package "docs/" {
  [设计文档真相源] as Docs
}
package "codex-rules/" {
  [Agent 操作规范] as Rules
}
package "scripts/quality/" {
  [质量门禁] as Quality
}
package ".github/" {
  [CI 工作流] as CI
}

Browser --> Index
Index --> Styles
Docs --> Index : 驱动内容与结构
Rules ..> Docs : 不替代
Quality --> Docs : 校验索引/链接/契约
Quality --> Index : 校验入口结构
CI --> Quality : 触发
@enduml
```

![架构概览组件图](../diagrams/architecture-overview.svg)

当前没有运行时后端、数据库、登录、评论系统或用户数据采集。

## 目标生产架构

首版生产环境采用 GitHub + 腾讯云 DNSPod + 腾讯云轻量应用服务器：

| 层级 | 组件 | 职责 |
|---|---|---|
| 源码与审核 | GitHub | Git 历史、PR、分支保护、Actions 质量门禁和 deployment 记录 |
| 本地预览 | 现有 Linux 预览机 | feature / `dev` 分支渲染与桌面/移动验收 |
| 域名解析 | 腾讯云 DNSPod | `axialmuse.com` 权威解析和 DNSSEC |
| 生产执行 | GitHub Actions + 腾讯云 TAT | 对 `main` 精确提交触发受限的原子发布 |
| Web 服务 | 腾讯云轻量应用服务器 + Nginx | HTTPS、重定向、安全头和静态资源 |
| 公开站点 | 当前为 `public/` 骨架；目标为 Docusaurus 静态构建产物，确切输出目录由发布契约另行确定 | 不包含主站运行时后端或数据库 |
| 项目体验 | `<project-slug>.axialmuse.com` | 已登记项目的独立静态体验、证书、发布和回滚边界 |


```plantuml
@startuml
left to right direction
actor "访问者浏览器" as Browser
cloud "DNSPod" as DNS
cloud "GitHub\n仓库与 Actions" as GitHub
cloud "腾讯云 API" as TencentApi
cloud "ACME CA" as Acme
node "上海轻量应用服务器" as Server {
  component "Nginx" as Nginx
  component "TAT agent" as Tat
  component "root-owned\n固定发布脚本" as Deploy
  folder "releases/<sha>" as Releases
  folder "current symlink" as Current
}

Browser --> DNS : DNS 查询
Browser --> Nginx : HTTPS
Nginx --> Current : 只读静态文件
GitHub --> TencentApi : InvokeCommand(SHA)
TencentApi --> Tat : 指定实例与命令
Tat --> Deploy : 仅传入 SHA
Deploy --> GitHub : 拉取 main 精确 SHA
Deploy --> Releases : 创建并校验
Deploy --> Current : 原子切换/回滚
Acme --> Nginx : HTTP-01 与证书续期
@enduml
```

![M0 目标生产架构图](../diagrams/production-architecture.svg)

主站生产发布必须来自 `main` 的精确提交，其他分支只在现有局域网环境预览。项目体验由各自仓库发布到独立子域名，主站只维护入口与注册表。完整子域名边界见 [项目体验子域名架构](project-experience-hosting.md)，服务器、DNS、备案、上线与回滚设计见 [域名与生产发布设计](../operations/domain-deployment.md)，运行责任见 [自动化维护与运行手册](../operations/maintenance.md)。

## 数据与请求流

### 设计到发布

1. 公开项目事实先写入 `docs/contracts/projects.json`，定位和页面规则写入 `docs/`。
2. 实现者在 `dev` 或 feature 分支更新当前 `public/` 骨架，并同步站点检查契约。
以下步骤描述当前 `public/` 骨架的迁移前流程。Docusaurus 内容源目录、构建位置、制品目录和交付方式仍待发布契约确认；Git 审核、精确 SHA、不可变 release 和原子回滚原则继续有效。

3. 本地与 CI 校验 Markdown、项目契约、密钥形态、静态资源和关键页面事实。
4. 真实浏览器完成桌面、平板、移动端和键盘验收，证据随 PR 评审。
5. `dev` 集成验证通过后创建 `dev -> main` PR；合入 `main` 后，GitHub Actions 只把精确 SHA 交给固定 TAT 发布命令。
6. 服务器创建不可变 release，验证后原子切换 `current`；失败则保持或恢复上一版本。

当前生产设计只读取已经审核的 `public/` 静态文件。Docusaurus 迁移后，生产请求将读取经过审核与验证的静态构建制品；制品在哪里构建、如何交付给服务器由发布契约另行确定。服务器在任何方案下都不成为内容编辑源。

### 浏览器请求

1. DNSPod 将 `www.axialmuse.com` 解析到轻量服务器。
2. Nginx 终止 TLS，校验精确 Host，并从 `/srv/axialmuse/current` 读取静态文件。
3. 当前骨架加载本地 HTML、CSS 和图片；Docusaurus 目标还会加载框架标准 React 客户端资源。未经批准时，页面不请求站点 API、第三方字体、分析或嵌入脚本。
4. 用户主动点击 GitHub 或备案链接时才离开本站。

### 信任边界

- **公开边界**：当前 `public/` 和未来 Docusaurus 静态制品中的 HTML、CSS、JavaScript、图片、视频、字幕和元数据均可被任何人下载，不能包含秘密或私人资料。
- **仓库边界**：GitHub 保存源码、公开文档和 CI 记录；GitHub secrets 只进入受控 workflow，不写入 release。
- **云控制面边界**：腾讯云保存 DNS、CAM、TAT、实例和证书运行状态；控制台不是内容真相源。
- **服务器边界**：Nginx 只读 release；发布脚本和证书由受限系统身份管理，网页内容不能写服务器磁盘。

## 故障隔离

- 页面内容或 CSS 错误通过切换 `current` 回滚，不修改 DNS 或重装服务器。
- Nginx 或证书错误先回滚对应配置，不重新发布页面内容。
- 主站与项目体验使用独立目录、证书和发布命令；一个体验失败不能切换主站 release。
- DocRestore 当前不创建 DNS、Nginx 或证书，因此其私有后端不会进入主站生产故障域。
- GitHub Actions、TAT 或公网检查失败时不得把未验证 release 标记为成功。

## 目录职责

- `public/`：首版静态网站入口和资源。
- `docs/`：定位、架构、内容模型、产品服务演进和契约词表的真相源。
- `docs/contracts/project-experiences.json`：已规划、上线、暂停和退役项目体验的公开事实注册表。
- `codex-rules/`：Codex 执行任务时的操作规范。
- `scripts/quality/`：CI 和本地质量门禁。
- `.github/`：PR 模板、CODEOWNERS 和 CI。
- 腾讯云（仓库外）：域名注册、DNS、轻量应用服务器、TAT 和账号控制面，非内容真相源。

## 演进原则

- 引入框架前先明确框架解决的问题，例如内容规模、路由、构建、SEO、MDX、搜索或部署需求。
- 引入用户交互前先明确隐私边界、滥用风险、数据保留和删除策略。
- 产品服务上线前先明确服务边界，不用营销文案替代真实能力说明。
- 项目体验必须先登记、隔离和验证，再配置主站入口；不能用泛解析替代项目治理。
- 域名、Git 仓库和静态产物必须保持可迁移，供应商后台不能成为唯一内容来源。

## 架构验收

- 当前 `public/` 是迁移前静态骨架；目标 release 由 Docusaurus 构建并由 Nginx 静态提供，确切输出目录待发布契约确认，生产请求不依赖 Node.js、数据库或第三方 API。
- 首版工程组件职责与 CI 门禁类别已经固定；具体版本、依赖、工具、构建位置、制品交付和服务器现场状态仍未确认，不能表述为已经部署。
- 从 contract 变更到页面、门禁、PR、`main` SHA、TAT invocation 和 release 的链路可追溯。
- DNS、TLS、Nginx、发布和页面内容可以分别验证和回滚。
- 浏览器、GitHub、腾讯云控制面和服务器四个信任边界没有共享网页可读取的凭证。
- 未登记或未批准的项目不会因泛解析、默认 Nginx Host 或页面占位链接意外公开。
