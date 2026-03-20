import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
	console.log("Activating..");

	const disposable = vscode.commands.registerCommand("mlsem.helloWorld", () => {
		vscode.window.showInformationMessage("Hello from MLsem!");
	});

	context.subscriptions.push(disposable);

	console.log("Activated.");
}

export function deactivate() {
	console.log("Deactivating..");
	console.log("Deactivated.");
}
