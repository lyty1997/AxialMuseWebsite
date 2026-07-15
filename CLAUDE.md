# CLAUDE.md

> **单一真相源在 [`AGENTS.md`](./AGENTS.md)。** 本项目规范同时供 Claude Code 与 Codex 读取，
> 为避免两份文件内容漂移，CLAUDE.md 不再单独维护正文，而是通过下方 `@` 导入 AGENTS.md。
> 任何规范改动只改 AGENTS.md。

@AGENTS.md

## Claude Code 专属差异

以下仅记录本环境与 AGENTS.md 默认表述不一致之处，其余一律以导入的 AGENTS.md 为准。

- 手工编辑使用 Edit / Write 工具。AGENTS.md 里的 `apply_patch` 是 Codex 的工具，本环境没有；“保留用户已有改动、不执行破坏性操作”这一约束同样适用。
