import sys
from os import environ

from agent.server import run_server


HOST = environ.get("PY_AGENT_HOST", "127.0.0.1")
PORT = int(environ.get("PY_AGENT_PORT", "8001"))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


if __name__ == "__main__":
    run_server(HOST, PORT)
