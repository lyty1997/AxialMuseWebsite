# 任务相关已知坑点

本文件仅供修改开发脚本、跨机预览或本地配置时读取；流程真相源见[跨机协同开发预览工作流](../docs/architecture/dev-workflow.md)。

- `scripts/dev/*.ps1` 含中文时必须保持带 BOM 的 UTF-8 和 CRLF。修改后确认首字节为 `EF BB BF`、文件仍为 CRLF；需要重写编码时使用 `[System.Text.UTF8Encoding]::new($true)`。
- `preview.sh` 只能接管同时满足“命令行为 `http.server`”和“服务当前预览目录”的 PID；端口被其他进程占用时直接失败，不写 PID 文件，也不停止该进程。
- 把分支名、路径等值拼入远端 shell 命令前必须验证字符：分支名使用白名单，路径拒绝引号、命令分隔符、替换符和换行等元字符。
- 新增应被忽略的本地配置后，必须执行 `git check-ignore -v <文件>` 验证实际命中规则；不能仅凭 `.gitignore` 模式外观判断。
