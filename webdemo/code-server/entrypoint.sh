#!/usr/bin/env bash
set -euo pipefail

# Ephemeral: start every container from a clean copy of the template project.
rm -rf /workspace/* /workspace/.[!.]* 2>/dev/null || true
rsync -a /template-project/ /workspace/

# NOTE: code-server has no `--base-path` flag. It supports being served under a
# sub-path (here `/s/<uuid>/`) natively, as long as the reverse proxy preserves
# the full request path and forwards the standard X-Forwarded-* headers. The
# broker does exactly that, so no path rewriting or base-path option is needed.
exec code-server \
  --bind-addr 0.0.0.0:8080 \
  --auth none \
  --disable-telemetry \
  /workspace
