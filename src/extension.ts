import * as vscode from "vscode";
import { LanguageClient, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";
import { Config } from "./config";
import { openTypeToolkit } from "./mergePanel";

let client: LanguageClient | undefined;
let traceOutputChannel: vscode.OutputChannel | undefined;
// Disposed at the end of deactivate, which still logs to it.
const output = vscode.window.createOutputChannel("MLsem", { log: true });

export async function activate(context: vscode.ExtensionContext) {
	output.info("Activating..");

	const config = new Config();

	const helloDisposable = vscode.commands.registerCommand("mlsem.helloWorld", () => {
		vscode.window.showInformationMessage("Hello from MLsem!");
	});
	context.subscriptions.push(helloDisposable);

	const mergeDisposable = vscode.commands.registerCommand(
		"mlsem.typeToolkit",
		(uri?: vscode.Uri, position?: vscode.Position) => {
			if (!client) {
				vscode.window.showErrorMessage("MLsem language server is not running.");
				return;
			}
			// From the code-action lightbulb we get the binding's location; from
			// the command palette we get nothing, so fall back to the active
			// editor's caret. Either way the open panel then follows the cursor.
			let targetUri = uri;
			let targetPosition = position;
			if (!targetUri || !targetPosition) {
				const editor = vscode.window.activeTextEditor;
				if (editor?.document.languageId === "mlsem") {
					targetUri = editor.document.uri;
					targetPosition = editor.selection.active;
				}
			}
			openTypeToolkit(context.extensionUri, client, targetUri, targetPosition);
		},
	);
	context.subscriptions.push(mergeDisposable);

	const restartDisposable = vscode.commands.registerCommand("mlsem.restartServer", async () => {
		if (!client) {
			vscode.window.showErrorMessage("MLsem language server is not configured.");
			return;
		}
		output.info("Restarting language server..");
		await client.restart();
		output.info("Language server restarted.");
	});
	context.subscriptions.push(restartDisposable);

	const codeActionProvider = vscode.languages.registerCodeActionsProvider(
		{ language: "mlsem" },
		{
			provideCodeActions(document, range) {
				const action = new vscode.CodeAction("MLsem: Type toolkit…", vscode.CodeActionKind.RefactorRewrite);
				action.command = {
					command: "mlsem.typeToolkit",
					title: "MLsem: Type toolkit…",
					arguments: [document.uri, range.start],
				};
				return [action];
			},
		},
		{ providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] },
	);
	context.subscriptions.push(codeActionProvider);

	const exePath = config.serverPath;
	if (exePath == null) {
		return Promise.reject("The `mlsem.server.path` option in VS Code settings is not set");
	}
	const serverOptions: ServerOptions = {
		run: {
			command: exePath,
		},
		debug: {
			command: exePath,
			options: { env: { MLSEM_LOG: "1", MLSEM_LOG_PACKETS: config.isTrace ? "1" : "0" } },
		},
	};

	// https://stackoverflow.com/questions/52447872/how-to-enable-logs-for-language-server-in-visual-studio-code
	// https://github.com/mun-lang/vscode-extension/blob/bbe1ebde2879ac4af853ad5f4bf43911c77a3c26/package.json#L88
	// See package.json:mlsem.trace.server, this should propagate to the LSP $/setTrace.
	// Not in context.subscriptions: those are disposed before deactivate, and the
	// client still writes to this channel while it shuts the server down.
	traceOutputChannel = vscode.window.createOutputChannel("MLsem Language Server Trace");

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: "file", language: "mlsem" }],
		outputChannelName: "MLsem Language Client",
		traceOutputChannel: traceOutputChannel,
		synchronize: {
			fileEvents: vscode.workspace.createFileSystemWatcher("**/*.mlsem"),
		},
		// Hovers lay out overloads as an HTML table with code blocks in its cells.
		markdown: { supportHtml: true },
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
	traceOutputChannel?.dispose();
	traceOutputChannel = undefined;

	output.info("Deactivated.");
	output.dispose();
}
