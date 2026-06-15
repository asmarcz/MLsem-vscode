import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

interface OverloadsResult {
	found: boolean;
	name: string;
	declared: boolean;
	overloads: { index: number; text: string }[];
}

interface MergePreviewResult {
	ok: boolean;
	text?: string;
	error?: string;
}

interface ApplyMergeResult {
	ok: boolean;
	edit?: {
		uri: string;
		range: {
			start: { line: number; character: number };
			end: { line: number; character: number };
		};
		newText: string;
	};
	error?: string;
}

type WebviewToExtension =
	| { type: "ready" }
	| { type: "requestPreview"; indices: number[] }
	| { type: "apply"; indices: number[] };

let panel: vscode.WebviewPanel | undefined;
let currentUri: vscode.Uri | undefined;
let currentPosition: vscode.Position | undefined;
let client: LanguageClient | undefined;
let followTimer: ReturnType<typeof setTimeout> | undefined;
// Serialize Apply: webview message handlers run concurrently and rapid clicks
// can post several "apply" messages, so without this lock multiple applyMerge
// requests reach the server before the first edit's didChange does — each sees
// the binding as undeclared and inserts a duplicate declaration. Dropping
// re-entrant applies (rather than queueing) collapses a click storm to one
// edit; a deliberate later Apply re-runs after didChange and replaces.
let applyInProgress = false;

function getNonce(): string {
	return crypto.randomBytes(16).toString("hex");
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri, nonce: string): string {
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
	const csp = [
		`default-src 'none'`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}'`,
	].join("; ");

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>MLsem: Merge Overloads</title>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

async function fetchOverloads(uri: vscode.Uri, position: vscode.Position): Promise<OverloadsResult | undefined> {
	if (!client) return undefined;
	return client.sendRequest<OverloadsResult>("mlsem/overloads", {
		textDocument: { uri: uri.toString() },
		position: { line: position.line, character: position.character },
	});
}

function postOverloads(result: OverloadsResult): void {
	panel?.webview.postMessage({
		type: "overloads",
		found: result.found,
		binding: { name: result.name, declared: result.declared },
		overloads: result.overloads,
	});
}

// Re-fetch the current target and post the result, whatever it is — used for
// explicit (re)opens and save-refreshes, where "no binding here" is useful
// feedback.
async function refreshCurrent(): Promise<void> {
	if (!panel || !currentUri || !currentPosition) return;
	const result = await fetchOverloads(currentUri, currentPosition);
	if (result) postOverloads(result);
}

// Follow the editor cursor: retarget the open panel to the binding under
// [position], but only when the server actually resolves one — so clicking
// off a binding keeps the current panel content instead of blanking it.
async function followCursor(uri: vscode.Uri, position: vscode.Position): Promise<void> {
	if (!panel) return;
	const result = await fetchOverloads(uri, position);
	if (!result?.found) return;
	currentUri = uri;
	currentPosition = position;
	postOverloads(result);
}

// The live text of the targeted document, sent with preview/apply requests so
// the server acts on exactly what the editor shows — not on its cache, which
// lags until the previous edit's didChange is processed.
function currentText(): string | undefined {
	if (!currentUri) return undefined;
	const uriStr = currentUri.toString();
	return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriStr)?.getText();
}

export function openMergePanel(
	extensionUri: vscode.Uri,
	lspClient: LanguageClient,
	uri: vscode.Uri | undefined,
	position: vscode.Position | undefined,
): void {
	client = lspClient;
	if (uri && position) {
		currentUri = uri;
		currentPosition = position;
	}

	if (panel) {
		panel.reveal(vscode.ViewColumn.Beside);
		refreshCurrent();
		return;
	}

	const nonce = getNonce();
	panel = vscode.window.createWebviewPanel("mlsemMergeOverloads", "MLsem: Merge Overloads", vscode.ViewColumn.Beside, {
		enableScripts: true,
		retainContextWhenHidden: true,
	});

	panel.webview.html = getHtml(panel.webview, extensionUri, nonce);

	const saveSubscription = vscode.workspace.onDidSaveTextDocument((doc) => {
		if (currentUri && doc.uri.toString() === currentUri.toString()) {
			refreshCurrent();
		}
	});

	// While the panel is open, follow the cursor in any MLsem editor so that
	// clicking a binding loads its overloads. Debounced so drag-selection and
	// rapid caret moves don't spam the server.
	const selectionSubscription = vscode.window.onDidChangeTextEditorSelection((event) => {
		if (event.textEditor.document.languageId !== "mlsem") return;
		const position = event.selections[0]?.active;
		if (!position) return;
		const uri = event.textEditor.document.uri;
		if (followTimer) clearTimeout(followTimer);
		followTimer = setTimeout(() => followCursor(uri, position), 120);
	});

	panel.webview.onDidReceiveMessage(async (message: WebviewToExtension) => {
		if (!panel || !client) return;

		if (message.type === "ready") {
			await refreshCurrent();
		} else if (message.type === "requestPreview") {
			if (!currentUri || !currentPosition) return;
			const result = await client.sendRequest<MergePreviewResult>("mlsem/mergePreview", {
				textDocument: { uri: currentUri.toString() },
				position: { line: currentPosition.line, character: currentPosition.character },
				indices: message.indices,
				text: currentText(),
			});
			panel.webview.postMessage({ type: "preview", ok: result.ok, text: result.text, error: result.error });
		} else if (message.type === "apply") {
			if (!currentUri || !currentPosition || applyInProgress) return;
			applyInProgress = true;
			try {
				const result = await client.sendRequest<ApplyMergeResult>("mlsem/applyMerge", {
					textDocument: { uri: currentUri.toString() },
					position: { line: currentPosition.line, character: currentPosition.character },
					indices: message.indices,
					text: currentText(),
				});

				if (result.ok && result.edit) {
					const we = new vscode.WorkspaceEdit();
					const editUri = vscode.Uri.parse(result.edit.uri);
					const range = new vscode.Range(
						new vscode.Position(result.edit.range.start.line, result.edit.range.start.character),
						new vscode.Position(result.edit.range.end.line, result.edit.range.end.character),
					);
					we.replace(editUri, range, result.edit.newText);
					await vscode.workspace.applyEdit(we);
					panel?.webview.postMessage({ type: "applied", ok: true });
				} else {
					panel?.webview.postMessage({ type: "applied", ok: false, error: result.error });
				}
			} finally {
				applyInProgress = false;
			}
		}
	});

	panel.onDidDispose(() => {
		saveSubscription.dispose();
		selectionSubscription.dispose();
		if (followTimer) clearTimeout(followTimer);
		followTimer = undefined;
		panel = undefined;
		currentUri = undefined;
		currentPosition = undefined;
	});
}
