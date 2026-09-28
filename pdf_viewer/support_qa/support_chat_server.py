import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from deepseek_client import call_deepseek


def _json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.end_headers()
    handler.wfile.write(body)


class SupportChatHandler(BaseHTTPRequestHandler):
    server_version = "LuotuSupportChat/1.0"

    def do_OPTIONS(self):
        _json_response(self, 200, {"ok": True})

    def do_GET(self):
        path = urlparse(self.path).path
        if path != "/health":
            _json_response(self, 404, {"detail": "Not found"})
            return

        configured = bool(os.environ.get("DEEPSEEK_API_KEY", "").strip())
        _json_response(self, 200, {
            "status": "ok" if configured else "missing_api_key",
            "ready": configured,
            "error": None if configured else "DEEPSEEK_API_KEY is not configured",
        })

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/api/support-chat":
            _json_response(self, 404, {"detail": "Not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length).decode("utf-8")
            payload = json.loads(raw_body or "{}")
        except Exception:
            _json_response(self, 400, {"detail": "请求体不是有效 JSON"})
            return

        question = str(payload.get("question") or "").strip()
        if not question:
            _json_response(self, 400, {"detail": "问题不能为空"})
            return
        if len(question) > 1000:
            _json_response(self, 400, {"detail": "问题过长，请精简后重试"})
            return

        try:
            result = call_deepseek(question)
            _json_response(self, 200, result)
        except Exception as exc:
            _json_response(self, 502, {"detail": f"帮助助手请求失败: {exc}"})

    def log_message(self, format, *args):
        print("%s - %s" % (self.address_string(), format % args), flush=True)


def main():
    host = os.environ.get("SUPPORT_CHAT_HOST", "0.0.0.0")
    port = int(os.environ.get("SUPPORT_CHAT_PORT", "8788"))
    server = ThreadingHTTPServer((host, port), SupportChatHandler)
    print(f"Luotu support chat service running on http://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

