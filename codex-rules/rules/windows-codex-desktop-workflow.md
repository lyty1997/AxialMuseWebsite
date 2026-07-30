# Windows Codex Desktop 工作流环境约束

适用范围：仅限在 Windows Codex Desktop 应用中开发和验证本项目。

- Windows 工作区 `C:\Users\Administrator\projects\AxialMuseWebsite` 是源码修改和 Git 操作的唯一工作区。
- 本地 CI 在 WSL 中运行。复用 `/home/lyty/.local/share/axialmuse-local-ci/` 中持久化的 Node、依赖和执行副本；普通开发过程不得反复删除或重装这套环境。WSL 副本只接收 Windows 工作区快照，不作为编辑、提交或反向覆盖 Windows 工作区的来源。
- 页面运行和 UI 验收使用 Codex Desktop 自带的应用内浏览器。WSL 不要求安装 Chromium，也不为此建立 Windows Chrome bridge、relay 或 CDP 包装器。
- 固定顺序为：在 Windows 工作区修改源码，同步快照到 WSL 并运行本地 CI，再由 Codex Desktop 应用内浏览器访问本地预览。
