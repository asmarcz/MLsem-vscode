# The three repos, each at the commit given by the deploy script (a full
# commit hash, so a new push changes the argument and the fetch reruns, while
# an unchanged repo keeps its cached layers).
ARG MLSEM_REPO=https://github.com/asmarcz/MLsem.git
ARG MLSEM_REF=webdemo
ARG VSCODE_REPO=https://github.com/asmarcz/MLsem-vscode.git
ARG VSCODE_REF=webdemo
ARG PROJECT_REPO=https://github.com/asmarcz/MLsem-dummy-project.git
ARG PROJECT_REF=webdemo

# ---------------------------------------------------------------------------
# Sources: one stage per repo, fetched at the given commit, .git removed.
# ---------------------------------------------------------------------------
FROM docker.io/alpine/git:v2.54.1 AS mlsem-src
ARG MLSEM_REPO
ARG MLSEM_REF
RUN git init -q /src && cd /src \
  && git fetch -q --depth 1 "$MLSEM_REPO" "$MLSEM_REF" \
  && git checkout -q FETCH_HEAD && rm -rf .git

FROM docker.io/alpine/git:v2.54.1 AS vscode-src
ARG VSCODE_REPO
ARG VSCODE_REF
RUN git init -q /src && cd /src \
  && git fetch -q --depth 1 "$VSCODE_REPO" "$VSCODE_REF" \
  && git checkout -q FETCH_HEAD && rm -rf .git

FROM docker.io/alpine/git:v2.54.1 AS project-src
ARG PROJECT_REPO
ARG PROJECT_REF
RUN git init -q /src && cd /src \
  && git fetch -q --depth 1 "$PROJECT_REPO" "$PROJECT_REF" \
  && git checkout -q FETCH_HEAD && rm -rf .git

# ---------------------------------------------------------------------------
# The extension .vsix, packaged from the MLsem-vscode sources.
# ---------------------------------------------------------------------------
FROM docker.io/oven/bun:1.4.5 AS vsix-build
WORKDIR /src
COPY --from=vscode-src /src/package.json /src/bun.lock ./
RUN bun install --frozen-lockfile
COPY --from=vscode-src /src ./
RUN bun run package && mv mlsem-vscode-*.vsix /mlsem-vscode.vsix

# ---------------------------------------------------------------------------
# Stage 1: build the MLsem LSP server from source.
# The MLsem type-checker/LSP is built with OCaml 5.6 + dune. `make lsp-build`
# produces _build/default/src/bin/lsp.exe.
# ---------------------------------------------------------------------------
FROM docker.io/ocaml/opam:debian-13-ocaml-5.6 AS lsp-build

# Assume "yes" for opam prompts (incl. depext apt installs) so the build is
# fully non-interactive.
ENV OPAMYES=1

WORKDIR /home/opam/MLsem
# The .opam files first: the dependency install below is cached until one of
# them changes, so a push that only changes code skips it.
COPY --from=mlsem-src --chown=opam:opam /src/*.opam ./

# `make deps` (opam install . --deps-only) would install deps for ALL packages,
# including mlsem-web, which drags in wasm_of_ocaml-compiler (needs binaryen and
# is unrelated to the LSP). Install deps only for the packages in the LSP's
# dependency chain instead, then build the LSP exactly like `make lsp-build`.
# These are exactly mlsem-lsp's transitive local dependency closure. They must
# all be passed together so opam's solver knows the sibling local packages
# exist (they are unpublished); mlsem-lsp depends on mlsem-app, which depends on
# mlsem, etc. Passing only mlsem-lsp.opam fails with "unknown package".
# --deps-only installs their *external* deps only; dune compiles the local libs
# from source in `make lsp-build`. mlsem-bin (the CLI) and mlsem-web (wasm) are
# outside this closure and deliberately omitted.
# NOTE: mlsem-types.opam carries a pin-depends for `sstt` (an unpublished git
# package). opam only honors pin-depends of packages pinned on the command
# line, so mlsem-types.opam MUST stay listed here; this is also why the opam
# step needs network access (it git-clones sstt) and why `opam update` is moot
# for it (sstt is in no repository index).
RUN opam install --deps-only \
  ./mlsem-types.opam \
  ./mlsem-common.opam \
  ./mlsem-system.opam \
  ./mlsem-lang.opam \
  ./mlsem.opam \
  ./mlsem-app.opam \
  ./mlsem-lsp.opam
COPY --from=mlsem-src --chown=opam:opam /src ./
# dune's shared cache in a cache mount, kept by the builder between builds: a
# push recompiles only what changed instead of all of MLsem. Copy mode, as
# hard links cannot cross into the mount.
ENV DUNE_CACHE=enabled DUNE_CACHE_STORAGE_MODE=copy
RUN --mount=type=cache,target=/home/opam/.cache/dune,uid=1000,gid=1000 \
  opam exec -- make lsp-build

# ---------------------------------------------------------------------------
# Stage 2: the ephemeral code-server session image.
# ---------------------------------------------------------------------------
FROM docker.io/codercom/code-server:4.145.2

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
  ca-certificates \
  libgmp10 \
  && rm -rf /var/lib/apt/lists/*

# Ordered from what changes least to what changes most (the LSP, on every
# MLsem push), so a rebuild redoes only the layers after the first change.
# Owners and modes are set by the COPYs: a chown -R in a later layer would
# store every file a second time.
COPY --chmod=755 code-server/entrypoint.sh /entrypoint.sh
RUN mkdir -p /workspace && chown coder:coder /workspace

USER coder

# The default user settings (code-server/settings.json). They and the
# extension live in the code-server data dir (baked into the image), so they
# survive the entrypoint's /workspace reset on every start.
# - mlsem.server.path: the LSP binary built above.
# - security.workspace.trust.enabled=false: the ephemeral /workspace folder is
#   untrusted on every fresh start, which puts VS Code in Restricted Mode and
#   disables the MLsem extension (it declares no untrustedWorkspaces
#   capability) until the user manually enables it. Safe here since the
#   workspace is our own template, not user code.
# - workbench.startupEditor=readme: open the project README on start.
# - window.autoDetectColorScheme: follow the browser's (the system's) light or
#   dark preference, with VS Code's default light and dark themes.
# The directory is made by coder: a COPY would create its parents as root.
RUN mkdir -p /home/coder/.local/share/code-server/User
COPY --chown=coder:coder code-server/settings.json /home/coder/.local/share/code-server/User/settings.json

RUN --mount=type=bind,from=vsix-build,source=/mlsem-vscode.vsix,target=/tmp/mlsem-vscode.vsix \
  code-server --install-extension /tmp/mlsem-vscode.vsix

# The starting project is the dummy project as it is.
COPY --from=project-src --chown=coder:coder /src /template-project

# MLsem LSP binary (built in stage 1) — the extension is pointed here.
COPY --from=lsp-build --chown=coder:coder --chmod=755 \
  /home/opam/MLsem/_build/default/src/bin/lsp.exe /opt/mlsem/lsp.exe

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
