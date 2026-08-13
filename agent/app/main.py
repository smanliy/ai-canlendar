import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from os import environ


HOST = environ.get("PY_AGENT_HOST", "127.0.0.1")
PORT = int(environ.get("PY_AGENT_PORT", "8001"))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


class AgentHandler(BaseHTTPRequestHandler):
    def _send_json(self, status_code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(
                200,
                {
                    "status": "ok",
                    "pid": os.getpid(),
                    "file": os.path.abspath(__file__),
                },
            )
            return

        self._send_json(404, {"message": "Not found"})

    def do_POST(self):
        print(f"\n[Python Agent] POST received: path={self.path}", flush=True)

        if self.path != "/agent/tasks":
            self._send_json(404, {"message": "Not found"})
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length).decode("utf-8")
        print(f"[Python Agent] Raw body: {raw_body}", flush=True)

        try:
            payload = json.loads(raw_body) if raw_body else {}
        except json.JSONDecodeError as error:
            print(f"[Python Agent] Invalid JSON: {error}", flush=True)
            self._send_json(400, {"message": f"Invalid JSON: {error}"})
            return

        print("[Python Agent] Parsed JSON from Node:")
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        print("[Python Agent] End parsed JSON\n", flush=True)

        self._send_json(
            200,
            {
                "message": "python received json",
                "received": payload,
            },
        )

    def log_message(self, format, *args):
        print(f"[Python Agent] {self.address_string()} - {format % args}", flush=True)


def main():
    print(f"[Python Agent] pid={os.getpid()} file={os.path.abspath(__file__)}", flush=True)
    server = ThreadingHTTPServer((HOST, PORT), AgentHandler)
    print(f"[Python Agent] listening at http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
