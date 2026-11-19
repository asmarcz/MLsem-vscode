"""GitHub webhook receiver for the webdemo.

Checks the signature of each request against WEBHOOK_SECRET and, for a push to
one of the branches in HOOK_TRIGGERS, touches TRIGGER_FILE. A systemd path unit
(webdemo-hook.path) watches that file and starts the deploy, so this process
needs no privileges: it runs as a throwaway user (see webdemo-hook.service).

Only the standard library, so it runs on the system Python as it is.
"""

import hashlib
import hmac
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SECRET = os.environ["WEBHOOK_SECRET"].encode()
PORT = int(os.environ.get("HOOK_PORT", "9001"))
# Comma-separated owner/repo:branch pairs whose pushes deploy.
TRIGGERS = {
    tuple(t.strip().split(":", 1))
    for t in os.environ.get("HOOK_TRIGGERS", "asmarcz/MLsem:webdemo").split(",")
    if t.strip()
}
TRIGGER_FILE = Path(os.environ.get("TRIGGER_FILE", "/run/webdemo-hook/trigger"))
MAX_BODY = 25 * 1024 * 1024  # GitHub caps payloads at 25 MB


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    def reply(self, code: int, text: str) -> None:
        body = (text + "\n").encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self.reply(400, "bad length")
        body = self.rfile.read(length)
        expected = "sha256=" + hmac.new(SECRET, body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, self.headers.get("X-Hub-Signature-256", "")):
            log(f"bad signature from {self.headers.get('X-Forwarded-For', self.client_address[0])}")
            return self.reply(401, "bad signature")
        event = self.headers.get("X-GitHub-Event", "")
        if event == "ping":
            return self.reply(200, "pong")
        if event != "push":
            return self.reply(202, f"ignored event {event}")
        payload = json.loads(body)
        repo = payload.get("repository", {}).get("full_name", "")
        ref = payload.get("ref", "")
        branch = ref.removeprefix("refs/heads/")
        if not ref.startswith("refs/heads/") or (repo, branch) not in TRIGGERS:
            return self.reply(202, f"ignored push to {repo}:{ref}")
        if payload.get("deleted"):
            return self.reply(202, "ignored branch deletion")
        TRIGGER_FILE.write_text(f"{repo}:{branch} {payload.get('after', '')}\n")
        log(f"deploy triggered by {repo}:{branch} {payload.get('after', '')}")
        self.reply(202, "deploying")

    def log_message(self, fmt: str, *args) -> None:
        log(fmt % args)


if __name__ == "__main__":
    log(f"listening on 127.0.0.1:{PORT}, triggers {sorted(TRIGGERS)}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
