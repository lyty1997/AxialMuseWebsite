# 已知注意事项

## 仓库状态

- 当前为 M0 静态网站骨架，尚未引入 Next.js、Astro、React、CMS、评论、订阅、登录或后端服务。
- `npm run quality` 不依赖第三方包，适合在空环境和 CI 中快速运行。

## 工具与验证

- UI 变更需要实际渲染验证；若当前环境无法启动浏览器或截图，应至少运行 `npm run quality` 并说明未做视觉验证。
- 质量脚本只做轻量静态检查，不能替代未来框架引入后的 lint、typecheck、test 和可访问性检查。
- **`.ps1` 脚本带中文注释时必须存成带 BOM 的 UTF-8，否则 Windows PowerShell 5.1 会解析失败。** 现象：直接执行报一堆看似不相关的语法错误（字符串缺少终止符、括号不匹配等），但用 `Read`/`cat` 看文件内容完全正常。原因：PowerShell 5.1 解析 `.ps1` 源码时，没有 BOM 就按系统 ANSI 代码页解码（中文 Windows 常见是 GB2312/GBK），把实际是 UTF-8 的中文字节序列读错，产生的乱字节又恰好破坏了词法分析。判断方法：`xxd 文件.ps1 | head -1` 看开头是不是 `ef bb bf`。修法：用 PowerShell 自己重新写盘一次，例如 `[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($true))`（`$true` 即写 BOM），普通 `Write`/`Set-Content -Encoding utf8`（不带 BOM 的那种）不够。在 Linux/Claude Code 环境下用 `Write` 工具改 `.ps1` 会丢失 BOM，需要事后用 `python3` 以 `encoding="utf-8-sig"` 重新写盘补回；`.gitattributes` 已声明 `*.ps1 text eol=crlf`，改完顺带确认行尾是 CRLF（`file 文件.ps1` 应显示 `with CRLF line terminators`），否则下次别的工具用 LF 重写又会把 CRLF 冲掉。`scripts/dev/*.ps1` 已按此修过，新增 `.ps1` 脚本时留意。
- **`preview.sh` 反查监听端口 PID 时，不能只看"端口有人监听"就直接接管。** 如果预览端口恰好被同机上不相关的进程占用（例如别的项目也用了 8088），旧版脚本会把那个无关 PID 当成"我们的服务"写进 `.preview.pid`，后续 `stop`/`restart` 就会去杀一个不该杀的进程。修法：新增 `pid_is_our_server()`，同时校验 `/proc/<pid>/cmdline` 里既含 `http.server` 又含本预览目录路径，两者都满足才认领；`start_server` 启动前也用它做一次"端口是否已被别的进程占用"的前置检查，遇到冲突直接报错退出，不冒险接管。
- **拼接远端 shell 命令字符串时，用户可控字段（分支名、路径）必须做字符白名单/黑名单校验，否则是命令注入面。** `restart-remote.ps1` 早期版本把 `$Branch`、`$RemoteRepoPath` 直接拼进 `ssh host "cd '$path' && ..."` 这样的字符串，如果这两个值里含有单引号等元字符就能逃逸包裹、在远端执行任意命令。修法：分支名用正则白名单 `^[A-Za-z0-9._/-]+$` 强制匹配，仓库路径用黑名单拒绝 `' " ; & | < > `` $ ( )` 等元字符，两者都在拼接前校验、不通过就直接报错退出。凡是"值会被拼进另一个 shell/命令字符串"的场景都要照此检查，不能假设调用方传入的值总是干净的。
- **新增被 `.gitignore` 忽略的本地配置文件时，必须用 `git check-ignore -v <文件>` 实测验证规则真的命中，不能凭"看起来应该匹配"就认为生效。** 曾经出现过 `.env`/`.env.*` 这类模式实际不匹配 `dev-workflow.env`（因为它是以 `.env` 结尾而不是以 `.env` 开头/包含 `.env.`），需要额外补一条精确路径规则 `scripts/dev/dev-workflow.env` 才真正生效。

## 内容风险

- 当前不要把未来产品服务写成已上线能力。
- 不要公开真实个人隐私、客户信息、未确认商业计划或敏感访问凭证。

