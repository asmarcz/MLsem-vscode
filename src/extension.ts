import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand("mlsem.helloWorld", () => {
		vscode.window.showInformationMessage("Hello from MLsem!");
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
