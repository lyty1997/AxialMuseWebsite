import functools
import http.server
import os
import sys

# 端口来自 PORT 环境变量（Claude Code 预览工具的 autoPort 分配），
# 默认 8000 兼容手动运行。
port = int(os.environ.get("PORT", 8000))
# 绑定地址默认 0.0.0.0（空串），以支持跨机 LAN 预览；设 BIND=127.0.0.1 可只监听本机。
# 注意：该静态服务器无鉴权，会把 directory 下所有文件对可达网络公开——
# 不要指向含密钥、.env 或 .git 的目录。
bind = os.environ.get("BIND", "")
directory = sys.argv[1] if len(sys.argv) > 1 else "public"
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
http.server.ThreadingHTTPServer((bind, port), handler).serve_forever()
