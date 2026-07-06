# 已知注意事项

## 仓库状态

- 当前为 M0 静态网站骨架，尚未引入 Next.js、Astro、React、CMS、评论、订阅、登录或后端服务。
- `npm run quality` 不依赖第三方包，适合在空环境和 CI 中快速运行。

## 工具与验证

- UI 变更需要实际渲染验证；若当前环境无法启动浏览器或截图，应至少运行 `npm run quality` 并说明未做视觉验证。
- 质量脚本只做轻量静态检查，不能替代未来框架引入后的 lint、typecheck、test 和可访问性检查。
- **`.ps1` 脚本带中文注释时必须存成带 BOM 的 UTF-8，否则 Windows PowerShell 5.1 会解析失败。** 现象：直接执行报一堆看似不相关的语法错误（字符串缺少终止符、括号不匹配等），但用 `Read`/`cat` 看文件内容完全正常。原因：PowerShell 5.1 解析 `.ps1` 源码时，没有 BOM 就按系统 ANSI 代码页解码（中文 Windows 常见是 GB2312/GBK），把实际是 UTF-8 的中文字节序列读错，产生的乱字节又恰好破坏了词法分析。判断方法：`xxd 文件.ps1 | head -1` 看开头是不是 `ef bb bf`。修法：用 PowerShell 自己重新写盘一次，例如 `[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($true))`（`$true` 即写 BOM），普通 `Write`/`Set-Content -Encoding utf8`（不带 BOM 的那种）不够。`scripts/dev/*.ps1` 已按此修过，新增 `.ps1` 脚本时留意。

## 内容风险

- 当前不要把未来产品服务写成已上线能力。
- 不要公开真实个人隐私、客户信息、未确认商业计划或敏感访问凭证。

