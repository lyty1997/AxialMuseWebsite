import functools
import http.server
import os

# 端口来自 PORT 环境变量（Claude Code 预览工具的 autoPort 分配），默认 8000 兼容手动运行。
port = int(os.environ.get("PORT", 8000))
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory="public")
http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
