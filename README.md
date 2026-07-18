# AxialMuseWebsite

Axial Muse Website 是个人项目与技术分享网站。第一版聚焦个人项目的技术文章、工程记录和可复盘的构建过程；后续逐步扩展为产品服务、产品背后的技术分享和公开讨论入口。

## 当前定位

- 个人技术分享：记录项目设计、实现取舍、工程规范和复盘。
- 项目展示：为 Axial Muse 相关项目保留清晰入口。
- 产品演进：后续产品服务上线前，先在 `docs/` 中完成定位、边界和信息架构设计。

## 工程规范入口

- Claude Code 指引：[CLAUDE.md](CLAUDE.md)
- 项目规范：[AGENTS.md](AGENTS.md)
- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)
- 文档入口：[docs/README.md](docs/README.md)
- 主站编码规范 Spec：[docs/engineering/main-site-coding-spec.md](docs/engineering/main-site-coding-spec.md)
- 项目进度：[docs/progress.md](docs/progress.md)
- Codex 规则：[codex-rules/global-AGENTS.md](codex-rules/global-AGENTS.md)
- 质量门禁脚本：[scripts/quality](scripts/quality)

## Linux 执行环境检查

```bash
npm run quality
```

在获准运行本站 Node.js 的 Linux 工作区，提交前门禁与 CI 共用同一质量入口；克隆后执行一次即可启用本地 pre-commit 钩子：

```bash
git config core.hooksPath .githooks
```

本站 Node.js 命令、质量检查和 Docusaurus 构建只在获准的 Linux 执行环境运行；Ubuntu CI 在合入与发布前执行统一验证。本地 hook 提供快捷反馈，但不能代替 CI。

当前首版不依赖第三方包，`quality` 使用 Node.js 内置能力检查：

- Markdown 内部链接和 `docs/README.md` 索引完整性。
- 契约词表和禁用旧名回潮。
- 常见密钥形态。
- 静态站点入口和资源引用。
