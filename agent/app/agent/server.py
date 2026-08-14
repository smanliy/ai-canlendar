import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .routes import handle_get, handle_post


class AgentServer(ThreadingHTTPServer):
    allow_reuse_address = False


class AgentHandler(BaseHTTPRequestHandler):
    def _send_json(self, status_code: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        status, payload = handle_get(self.path)
        if self.path == "/health":
            payload = {
                **payload,
                "pid": os.getpid(),
                "file": os.path.abspath(__file__),
            }
        self._send_json(status, payload)

    def do_POST(self) -> None:
        print(f"\n[Python Agent] POST received: path={self.path}", flush=True)
        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length).decode("utf-8")
        print(f"[Python Agent] Raw body: {raw_body}", flush=True)
        status, payload = handle_post(self.path, raw_body)
        self._send_json(status, payload)

    def log_message(self, format: str, *args: object) -> None:
        print(f"[Python Agent] {self.address_string()} - {format % args}", flush=True)


def run_server(host: str, port: int) -> None:
    print(f"[Python Agent] pid={os.getpid()} file={os.path.abspath(__file__)}", flush=True)
    server = AgentServer((host, port), AgentHandler)
    print(f"[Python Agent] listening at http://{host}:{port}", flush=True)
    server.serve_forever()
