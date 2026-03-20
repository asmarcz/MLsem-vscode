import * as vscode from "vscode";

const output = vscode.window.createOutputChannel("MLsem", { log: true });

export function activate(context: vscode.ExtensionContext) {
	output.info("Activating..");

	const disposable = vscode.commands.registerCommand("mlsem.helloWorld", () => {
		vscode.window.showInformationMessage("Hello from MLsem!");
	});

	context.subscriptions.push(disposable);
	context.subscriptions.push(output);

	output.info("Activated.");
}

export function deactivate() {
	output.info("Deactivating..");
	output.info("Deactivated.");
}
