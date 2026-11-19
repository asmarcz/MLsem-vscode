"""Build and (re)start the webdemo from the current heads of the three repos.

Run by webdemo-deploy.service (started by the webhook), as root, from a clone
of MLsem-vscode. Steps:
  1. update the clone to the deployed branch (the compose file, the
     Dockerfiles and these scripts come from it), unless --local;
  2. resolve the branch heads of MLsem, MLsem-vscode and the dummy project;
  3. build the images while the old demo keeps running;
  4. restart webdemo-stack.service on the new images, prune the old ones,
     check the public path. Skipped when the images, the compose file and the
     env file are those the demo already runs (a push that changed nothing
     the demo uses builds from the cache in seconds and restarts nothing).
A push during step 3 (the webhook touches the trigger file again) stops the
build and starts over from step 1, so pushes to several repos for one change
end in one finished build. The layers the stopped build finished stay cached.
Repeats while a branch moved during the deploy, so a push that came in after
the build (and whose trigger systemd dropped) is still deployed.

--force deploys even when nothing changed since the last deploy.
"""

import hashlib
import json
import os
import signal
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
# The images compose builds: the session image and the broker.
IMAGES = ["localhost/vscode-demo-code-server:latest", "localhost/webdemo_broker:latest"]
# Touched by the webhook receiver on each push that deploys.
TRIGGER = Path(os.environ.get("TRIGGER_FILE", "/run/webdemo-hook/trigger"))

# (compose build argument, repository, branch)
SOURCES = [
    ("MLSEM_REF", os.environ.get("MLSEM_REPO", "https://github.com/asmarcz/MLsem.git"),
     os.environ.get("MLSEM_BRANCH", "webdemo")),
    ("VSCODE_REF", os.environ.get("VSCODE_REPO", "https://github.com/asmarcz/MLsem-vscode.git"),
     os.environ.get("VSCODE_BRANCH", "webdemo")),
    ("PROJECT_REF", os.environ.get("PROJECT_REPO", "https://github.com/asmarcz/MLsem-dummy-project.git"),
     os.environ.get("PROJECT_BRANCH", "webdemo")),
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


def last_push() -> int:
    try:
        return TRIGGER.stat().st_mtime_ns
    except FileNotFoundError:
        return 0


def build(refs: dict[str, str], seen: int) -> bool:
    """Build the images; False if a newer push (the trigger file changed since
    `seen`) stopped the build."""
    log("building " + " ".join(f"{k}={v[:12]}" for k, v in refs.items()))
    p = sh.podman_compose("--env-file", ENV_FILE, "build", _cwd=WEBDEMO,
                          _env={**os.environ, **refs}, _out=sys.stdout, _err=sys.stderr,
                          _bg=True, _bg_exc=False, _new_session=True)
    try:
        while p.is_alive():
            if last_push() != seen:
                log("a newer push came in: stopping this build")
                stop(p.process.pgid)
                # The stopped build leaves its working containers, which keep
                # their images from being pruned. This is the only builder.
                out.buildah("rm", "--all")
                return False
            time.sleep(2)
        p.wait()  # raises if the build failed
        return True
    finally:
        stop(p.process.pgid)


def stop(pgid: int) -> None:
    # The build runs in its own process group (podman-compose and the podman
    # builds it starts): stop all of it, politely first.
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            break
        time.sleep(5)


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


def replace(old: dict[str, str], new: dict[str, str]) -> bool:
    log("replacing the running demo")
    # Through its own unit: containers started from this oneshot unit would be
    # killed when it ends (see webdemo-stack.service).
    out.systemctl("restart", "webdemo-stack.service")
    ok = healthy()
    # The disk is small: drop the images this build replaced. Not a plain
    # `image prune`: the untagged images it removes include the build cache
    # (the source fetches, the opam install, the extension build), which made
    # every deploy a full rebuild. Untagged images unused for a week go, so
    # the cache of old commits does not pile up. Failures here only leave
    # disk space taken: log them and go on.
    stale = [i for name, i in old.items() if name in IMAGES and i != new.get(name)]
    for cmd in (["rmi", *stale] if stale else None,
                ["image", "prune", "-f", "--filter", "until=168h"]):
        if cmd:
            r = out.podman(*cmd, _ok_code=range(256), _return_cmd=True)
            if r.exit_code:
                log(f"podman {cmd[0]} {cmd[1]} failed ({r.exit_code}), continuing")
    return ok


def running_setup() -> dict[str, str]:
    """What the demo would run with: the two images and the files the stack
    reads. Equal to the running one means a restart would change nothing."""
    ids = str(parsed.podman("image", "inspect", "--format", "{{.Id}}", *IMAGES)).split()
    files = {f.name: hashlib.sha256(f.read_bytes()).hexdigest()
             for f in (WEBDEMO / "docker-compose.yml", Path(ENV_FILE))}
    return {**dict(zip(IMAGES, ids)), **files}


def main() -> int:
    local = "--local" in sys.argv
    force = "--force" in sys.argv
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    last, running = state.get("refs"), state.get("running")
    while True:
        # Before reading the heads: a push after this point stops the build.
        seen = last_push()
        if not local:
            update_clone()
        refs = heads()
        if refs == last and not force:
            log("nothing new to deploy")
            return 0
        if not build(refs, seen):
            continue
        setup = running_setup()
        if setup == running and not force and is_active("webdemo-stack.service"):
            # E.g. a push that only changed the deploy scripts or docs.
            log("same images and settings as the running demo: left running")
        elif not replace(running or {}, setup):
            out.podman("logs", "--tail", "40", "vscode-demo-broker", _ok_code=range(256))
            return 1
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps({"refs": refs, "running": setup}, indent=1) + "\n")
        last, running, force = refs, setup, False


def is_active(unit: str) -> bool:
    return out.systemctl("is-active", "--quiet", unit, _ok_code=range(256),
                         _return_cmd=True).exit_code == 0


if __name__ == "__main__":
    sys.exit(main())
