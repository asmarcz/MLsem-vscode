"""One-time (idempotent) setup of the webdemo host, run as root on the server:

    apt install python3-sh git podman podman-compose caddy
    git clone https://github.com/asmarcz/MLsem-vscode.git /srv/webdemo/MLsem-vscode
    python3 /srv/webdemo/MLsem-vscode/webdemo/deploy/setup.py

Creates /etc/webdemo/webdemo.env (from .env.example) and /etc/webdemo/hook.env
(a fresh webhook secret, printed once) when missing, installs the Caddy config
and the systemd units, and enables everything that must survive a reboot:
podman.socket (the broker talks to it), webdemo-stack.service (the demo), the
webhook receiver and its trigger. Existing env files are kept.
"""

import secrets
import shutil
import sys
from pathlib import Path

import sh

DEPLOY = Path(__file__).resolve().parent
WEBDEMO = DEPLOY.parent
ETC = Path("/etc/webdemo")
UNITS = ["webdemo-hook.service", "webdemo-hook.path", "webdemo-deploy.service", "webdemo-stack.service"]

out = sh.bake(_out=sys.stdout, _err=sys.stderr)


def env_files() -> None:
    ETC.mkdir(mode=0o755, exist_ok=True)
    env = ETC / "webdemo.env"
    if not env.exists():
        text = (WEBDEMO / ".env.example").read_text()
        # The broker talks to the system (rootful) Podman socket.
        env.write_text(text + "\nDOCKER_SOCKET=/run/podman/podman.sock\n")
        print(f"wrote {env}")
    hook = ETC / "hook.env"
    if not hook.exists():
        secret = secrets.token_hex(32)
        hook.touch(mode=0o600)
        hook.write_text(
            "# Shared with the GitHub webhook (Settings -> Webhooks -> Secret).\n"
            f"WEBHOOK_SECRET={secret}\n"
            "# owner/repo:branch pairs whose pushes deploy, comma-separated.\n"
            "HOOK_TRIGGERS=asmarcz/MLsem:webdemo,asmarcz/MLsem-vscode:master,"
            "asmarcz/MLsem-dummy-project:main\n"
        )
        print(f"wrote {hook}; webhook secret: {secret}")


def caddy() -> None:
    shutil.copy(WEBDEMO / "caddy" / "Caddyfile", "/etc/caddy/Caddyfile")
    out.caddy("validate", "--config", "/etc/caddy/Caddyfile")
    out.systemctl("reload", "caddy")


def units() -> None:
    for u in UNITS:
        shutil.copy(DEPLOY / u, f"/etc/systemd/system/{u}")
    out.systemctl("daemon-reload")
    out.systemctl("enable", "--now", "podman.socket", "webdemo-hook.service", "webdemo-hook.path")
    # At boot, not now: starting it here would build the images with compose
    # if a deploy has not built them yet.
    out.systemctl("enable", "webdemo-stack.service")
    # webdemo-stack.service starts the broker at boot; podman-restart would
    # race it for the same container.
    out.systemctl("disable", "podman-restart.service")
    # Pick up a changed hook.py or unit.
    out.systemctl("restart", "webdemo-hook.service")


if __name__ == "__main__":
    env_files()
    caddy()
    units()
