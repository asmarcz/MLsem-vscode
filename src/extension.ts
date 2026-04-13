import * as vscode from "vscode";
import { LanguageClient, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";

let client: LanguageClient | undefined;
const output = vscode.window.createOutputChannel("MLsem", { log: true });

export async function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(output);
	output.info("Activating..");

	const disposable = vscode.commands.registerCommand("mlsem.helloWorld", () => {
		vscode.window.showInformationMessage("Hello from MLsem!");
	});
	context.subscriptions.push(disposable);

	const exePath = vscode.Uri.joinPath(context.extensionUri, "lsp.exe").fsPath;
	const serverOptions: ServerOptions = {
		run: {
			command: exePath,
		},
		debug: {
			command: exePath,
		},
	};

	// https://stackoverflow.com/questions/52447872/how-to-enable-logs-for-language-server-in-visual-studio-code
	// https://github.com/mun-lang/vscode-extension/blob/bbe1ebde2879ac4af853ad5f4bf43911c77a3c26/package.json#L88
	// See package.json:mlsem.trace.server, this should propagate to the LSP $/setTrace.
	const traceOutputChannel = vscode.window.createOutputChannel("MLsem Language Server Trace");
	context.subscriptions.push(traceOutputChannel);

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: "file", language: "mlsem" }],
		outputChannelName: "MLsem Language Client",
		traceOutputChannel: traceOutputChannel,
		synchronize: {
			fileEvents: vscode.workspace.createFileSystemWatcher("**/*.mlsem"),
		},
	};
	client = new LanguageClient("mlsem", "MLsem Language Client", serverOptions, clientOptions);

	output.info("Starting language server..");
	await client.start();
	output.info("Language server started.");

	output.info("Activated.");
}

export async function deactivate() {
	output.info("Deactivating..");

	await client?.dispose();
	client = undefined;

	output.info("Deactivated.");
}
