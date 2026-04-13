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
	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: "file", language: "mlsem" }],
		synchronize: {
			fileEvents: vscode.workspace.createFileSystemWatcher("**/*.mlsem"),
		},
	};
	client = new LanguageClient("mlsemLanguageClient", "MLsem Language Client", serverOptions, clientOptions);

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
