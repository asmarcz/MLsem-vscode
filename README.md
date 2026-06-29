# Setup

## Install MLsem LSP

The extension requires the MLsem typechecking library. Obtain it at https://github.com/E-Sh4rk/MLsem.

These instructions assume a working OCaml/opam installation.

To build the LSP server used by this extension, run:
```
git clone https://github.com/E-Sh4rk/MLsem
cd MLsem
make lsp-dev-build
export LSP_BIN=$(realpath _build/default/src/bin/lsp.exe)
```

## VS Code

To build and install the VS Code extension, run:
```
npm run package -- --allow-missing-repository
code --install-extension mlsem-vscode-0.0.1.vsix
```

After installing the extension, open the VS Code setting using the command palette (Ctrl+Shift+P -> "Open User Settings"). In the preferences,
set `mlsem.server.path` to the path of LSP server binary which
should be `$LSP_BIN` from our previous steps.

# Debugging

If you want to see the LSP logs, set `mlsem.trace.server`.

1. Create a VS Code Profile called "MLsem Debug". You can use the "Preferences: Open Profiles (UI)" command.
2. You can start debugging from the "Run and Debug" menu.
