# VibeCoding Project Scaffold 项目展示设计

状态：active
最近更新：2026-07-29
适用范围：主站项目说明、公开仓库、视觉证据与公开表达

## 目的

本文定义 VibeCoding Project Scaffold 在 Axial Muse 主站中的公开展示内容。该项目是用于初始化 AI 辅助开发项目的可复用工程脚手架，重点不是提供在线 Web 应用，而是把设计文档、Agent 规则、质量门禁、CI 和 Git 工作流作为新项目的可执行起点。

首版只展示项目说明和 GitHub 仓库，不创建子域名，不提供在线体验，也不要求演示视频。主站 CTA 使用“查看源码”，不得显示“在线体验”。

## 已确认事实

| 项目 | 当前值 |
|---|---|
| 项目名称 | `VibeCoding Project Scaffold` |
| GitHub 仓库 | `https://github.com/lyty1997/project-scaffold` |
| 生产分支 | `main` |
| 本地核对路径 | `/home/lyty/work/personal_projects/project-scaffold`，仅用于内容核对，不写入公开页面 |
| 初始化入口 | `npm run init` 或 `node scripts/init.mjs` |
| 质量入口 | `npm run quality` |
| Node.js | `>=22` |
| 首版第三方 npm 依赖 | 无；质量脚本使用 Node.js 内置能力 |
| 许可证 | Apache License 2.0 |
| 仓库最早提交 | 2026-07-05，本地 Git 历史核对 |
| `origin/main` 最近核对提交 | `a9f6cd51c843f417858ae0417191523d0df11d84`，2026-07-26，通过 GitHub `main` 核对 |
| 在线体验 | 不提供 |

本地克隆的 origin 已核对为 `https://github.com/lyty1997/project-scaffold.git`。README 中保留 `__PROJECT_NAME__` 等占位符是脚手架模板的一部分，使用者运行初始化命令后才替换为实际项目信息。

本轮项目正文与关联技术分享的工程事实固定核对
[`main@a9f6cd51c843f417858ae0417191523d0df11d84`](https://github.com/lyty1997/project-scaffold/tree/a9f6cd51c843f417858ae0417191523d0df11d84)。
后续仓库变化不会自动改写已经发布的文章结论；涉及能力、命令或边界变化时，必须重新核对并形成文章修订。

## 主站项目正文

问题、能力、取舍、限制、证据说明与复盘只在[主站项目正文](../../site-content/projects/vibecoding-project-scaffold/index.md)中维护。本文继续拥有仓库事实、页面动作、视觉证据、公开边界和验收门禁，不复制主站叙事。

## 页面动作

| 动作 | 文案 | 目标 |
|---|---|---|
| 主动作 | 查看源码 | `https://github.com/lyty1997/project-scaffold` |
| 在线体验 | 不显示 | 该项目没有需要运行的公共 Web 体验 |
| 演示视频 | 首版不显示 | 当前不是发布前置条件 |

## 关联技术分享

《VibeCoding Project Scaffold：从一次对话到可复用的工程闭环》不是与项目并列的泛化文章，
而是该项目的主技术分享和设计、实现、复盘记录。源码位于
`site-content/writing/ai-coding-scaffold-engineering-loop/index.md`，文章以 classification
归入项目根级，项目注册表再用稳定 articleId 建立反向关联，并归入
`ai-assisted-development` 主题。文章先以 `draft` 进入 preview，完成事实、图表、链接、
桌面与移动阅读体验审核后，再由作者显式切换为 `published` 并写入发布日期。

文章中的四张 PlantUML 图解释脚手架分层、任务闭环、迁移流程和演进方向，属于技术说明，
不替代本项目仍待准备的真实终端或仓库工程截图，也不作为项目主预览证据。

## 视觉证据

主站实现时优先使用项目自身的真实证据，不使用泛化的 AI 机器人或抽象科技素材。候选方案按优先级排列：

1. 初始化命令运行前后的真实终端画面，使用专门创建的无敏感示例目录。
2. 仓库目录结构与质量门禁通过结果的组合截图。
3. GitHub 仓库公开页面截图，但需避免出现私人通知、登录状态或浏览器扩展信息。

截图发布前移除本机用户名、绝对路径、IP、远程地址中的凭证、通知和其他隐私信息。图片应提供有意义的替代文本，并保留原始截图来源与制作日期。

## 公开边界

- 不创建 `project-scaffold.axialmuse.com` 或其他体验子域名。
- 不把初始化脚本作为主站在线工具运行，不接受用户上传、表单或任意项目输入。
- 不收集访问者数据，不引入登录、Cookie、分析或第三方嵌入。
- GitHub 链接只是公开源码入口，不向主站提供仓库写权限或任何凭证。
- 后续新增演示视频、在线生成器、模板下载服务或产品服务前，必须先更新本文的数据、支持和安全边界。

## 验收标准

- 项目名称、仓库、分支、许可证和命令与公开仓库一致。
- 页面清楚说明它是工程脚手架，不把模板占位符误写成未完成产品。
- 只展示“查看源码”，不出现不可用的在线体验或视频入口。
- 公开截图来自真实项目，且通过凭证、隐私和版权检查。
- 项目摘要、问题、取舍和证据均能追溯到仓库文件。
