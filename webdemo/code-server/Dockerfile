# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: build the MLsem LSP server from source.
# The MLsem type-checker/LSP lives in a separate repo and is built with OCaml
# 5.3 + dune. `make lsp-build` produces _build/default/src/bin/lsp.exe.
# ---------------------------------------------------------------------------
FROM docker.io/ocaml/opam:debian-12-ocaml-5.3 AS lsp-build

# Assume "yes" for opam prompts (incl. depext apt installs) so the build is
# fully non-interactive.
ENV OPAMYES=1

RUN git clone --depth 1 https://github.com/E-Sh4rk/MLsem.git /home/opam/MLsem
WORKDIR /home/opam/MLsem

# `make deps` (opam install . --deps-only) would install deps for ALL packages,
# including mlsem-web, which drags in wasm_of_ocaml-compiler (needs binaryen and
# is unrelated to the LSP). Install deps only for the packages in the LSP's
# dependency chain instead, then build the LSP exactly like `make lsp-build`.
RUN opam install --deps-only \
    ./mlsem.opam \
    ./mlsem-common.opam \
    ./mlsem-types.opam \
    ./mlsem-lang.opam \
    ./mlsem-system.opam \
    ./mlsem-app.opam \
    ./mlsem-lsp.opam \
    ./mlsem-bin.opam \
  && make lsp-build

# ---------------------------------------------------------------------------
# Stage 2: the ephemeral code-server session image.
# ---------------------------------------------------------------------------
FROM docker.io/codercom/code-server:latest

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    rsync \
    ca-certificates \
    libgmp10 \
  && rm -rf /var/lib/apt/lists/*

# MLsem LSP binary (built in stage 1) — the extension is pointed here.
COPY --from=lsp-build /home/opam/MLsem/_build/default/src/bin/lsp.exe /opt/mlsem/lsp.exe

# Paths are relative to the build context (the webdemo directory), which holds
# the demo assets and a copy of the extension .vsix.
COPY demo-project /template-project
COPY code-server/entrypoint.sh /entrypoint.sh
COPY mlsem-vscode-*.vsix /tmp/mlsem-vscode.vsix

RUN chmod +x /entrypoint.sh /opt/mlsem/lsp.exe \
  && mkdir -p /workspace \
  && chown -R coder:coder /workspace /template-project /entrypoint.sh /opt/mlsem

USER coder

# Install the extension and point mlsem.server.path at the built LSP binary.
# The extension + settings live in the code-server data dir (baked into the
# image), so they survive the entrypoint's /workspace reset on every start.
# security.workspace.trust.enabled=false: the ephemeral /workspace folder is
# untrusted on every fresh start, which puts VS Code in Restricted Mode and
# disables the MLsem extension (it declares no untrustedWorkspaces capability)
# until the user manually enables it. Disabling trust keeps it enabled by
# default — safe here since the workspace is our own template, not user code.
# workbench.startupEditor=readme: open the project README (rendered preview) on
# start so each session lands on the demo instructions.
RUN code-server --install-extension /tmp/mlsem-vscode.vsix \
  && mkdir -p /home/coder/.local/share/code-server/User \
  && printf '{\n  "mlsem.server.path": "/opt/mlsem/lsp.exe",\n  "security.workspace.trust.enabled": false,\n  "workbench.startupEditor": "readme"\n}\n' \
     > /home/coder/.local/share/code-server/User/settings.json

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
