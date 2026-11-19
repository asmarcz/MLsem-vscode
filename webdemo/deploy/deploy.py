"""Build and (re)start the webdemo from the current heads of the three repos.

Run by webdemo-deploy.service (started by the webhook), as root, from a clone
of MLsem-vscode. Steps:
  1. update the clone to the deployed branch (the compose file, the
     Dockerfiles and these scripts come from it), unless --local;
  2. resolve the branch heads of MLsem, MLsem-vscode and the dummy project;
  3. build the images while the old demo keeps running;
  4. replace the running stack, prune old images, check the public path.
Repeats while a branch moved during the build, so a push that came in while
the deploy ran (and whose trigger systemd dropped) is still deployed.

--force deploys even when nothing changed since the last deploy.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import sh

WEBDEMO = Path(__file__).resolve().parent.parent
REPO = WEBDEMO.parent
ENV_FILE = os.environ.get("WEBDEMO_ENV_FILE", "/etc/webdemo/webdemo.env")
STATE = Path(os.environ.get("WEBDEMO_STATE", "/var/lib/webdemo/deployed.json"))
HEALTH_URL = "http://127.0.0.1/" + os.environ.get("BASE_PATH", "/webdemo").strip("/") + "/"

# (compose build argument, repository, branch)
SOURCES = [
    ("MLSEM_REF", os.environ.get("MLSEM_REPO", "https://github.com/asmarcz/MLsem.git"),
     os.environ.get("MLSEM_BRANCH", "webdemo")),
    ("VSCODE_REF", os.environ.get("VSCODE_REPO", "https://github.com/asmarcz/MLsem-vscode.git"),
     os.environ.get("VSCODE_BRANCH", "master")),
    ("PROJECT_REF", os.environ.get("PROJECT_REPO", "https://github.com/asmarcz/MLsem-dummy-project.git"),
     os.environ.get("PROJECT_BRANCH", "main")),
]

out = sh.bake(_out=sys.stdout, _err=sys.stderr)
parsed = sh.bake(_tty_out=False, _truncate_exc=False)


def log(msg: str) -> None:
    print(f"== {msg}", flush=True)


def update_clone() -> None:
    branch = dict((k, b) for k, _, b in SOURCES)["VSCODE_REF"]
    out.git("-C", REPO, "fetch", "--quiet", "origin", branch)
    out.git("-C", REPO, "reset", "--hard", "--quiet", "FETCH_HEAD")


def heads() -> dict[str, str]:
    refs = {}
    for arg, repo, branch in SOURCES:
        line = str(parsed.git("ls-remote", "--exit-code", repo, f"refs/heads/{branch}"))
        refs[arg] = line.split()[0]
    return refs


def compose(*args: str, env: dict[str, str] | None = None) -> None:
    out.podman_compose("--env-file", ENV_FILE, *args, _cwd=WEBDEMO,
                       _env={**os.environ, **(env or {})})


def healthy(timeout: float = 120) -> bool:
    deadline = time.monotonic() + timeout
    status: int | str = "no answer"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(HEALTH_URL, timeout=10) as resp:
                log(f"{HEALTH_URL} -> {resp.status}")
                return True
        except urllib.error.HTTPError as e:
            status = e.code
        except OSError as e:
            status = str(e)
        time.sleep(3)
    log(f"{HEALTH_URL} still failing after {timeout:.0f}s: {status}")
    return False


def deploy(refs: dict[str, str]) -> bool:
    log("building " + " ".join(f"{k}={v[:12]}" for k, v in refs.items()))
    compose("build", env=refs)
    log("replacing the running demo")
    # The broker starts session containers itself, so compose does not know
    # about them. They run the old image and hold the network: remove first.
    ids = str(parsed.podman("ps", "-aq", "--filter", "name=vscode-demo-session")).split()
    if ids:
        out.podman("rm", "-f", *ids)
    compose("down", env=refs)
    compose("up", "-d", env=refs)
    # The disk is small: drop the images the rebuild replaced.
    out.podman("image", "prune", "-f")
    return healthy()


def main() -> int:
    local = "--local" in sys.argv
    force = "--force" in sys.argv
    last = json.loads(STATE.read_text()) if STATE.exists() else None
    while True:
        if not local:
            update_clone()
        refs = heads()
        if refs == last and not force:
            log("nothing new to deploy")
            return 0
        if not deploy(refs):
            out.podman("logs", "--tail", "40", "vscode-demo-broker", _ok_code=range(256))
            return 1
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps(refs, indent=1) + "\n")
        last, force = refs, False


if __name__ == "__main__":
    sys.exit(main())
