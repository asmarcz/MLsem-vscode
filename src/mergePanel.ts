import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

interface OverloadsResult {
	found: boolean;
	name: string;
	declared: boolean;
	overloads: string[];
	overloadVars: string[][];
	concreteTypes: string[];
}

interface MergePreviewResult {
	ok: boolean;
	text?: string;
	error?: string;
}

interface EditRange {
	start: { line: number; character: number };
	end: { line: number; character: number };
}

interface EditResult {
	ok: boolean;
	uri?: string;
	edits?: { range: EditRange; newText: string }[];
	stale?: boolean;
	error?: string;
}

interface InstantiatePreviewResult {
	ok: boolean;
	overloads?: string[];
	stale?: boolean;
	error?: string;
}

// One overload's variable -> concrete-type assignments.
interface Instantiation {
	overload: string;
	assignments: { var: string; type: string }[];
}

type WebviewToExtension =
	| { type: "ready" }
	| { type: "requestPreview"; name: string; overloadTexts: string[] }
	| { type: "apply"; name: string; overloadTexts: string[] }
	| { type: "requestInstantiatePreview"; name: string; instantiations: Instantiation[] }
	| { type: "applyInstantiate"; name: string; instantiations: Instantiation[] };

let panel: vscode.WebviewPanel | undefined;
let currentUri: vscode.Uri | undefined;
let currentPosition: vscode.Position | undefined;
let client: LanguageClient | undefined;
let followTimer: ReturnType<typeof setTimeout> | undefined;

function getNonce(): string {
	return crypto.randomBytes(16).toString("hex");
}

// The live text of a document, sent with every request so the server typechecks
// and resolves (by position or name) against exactly what the editor shows.
function textOf(uri: vscode.Uri): string | undefined {
	const s = uri.toString();
	return vscode.workspace.textDocuments.find((d) => d.uri.toString() === s)?.getText();
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
	<title>MLsem: Type toolkit</title>
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
		text: textOf(uri),
	});
}

function postOverloads(result: OverloadsResult): void {
	panel?.webview.postMessage({
		type: "overloads",
		found: result.found,
		binding: { name: result.name, declared: result.declared },
		overloads: result.overloads,
		overloadVars: result.overloadVars,
		concreteTypes: result.concreteTypes,
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

export function openTypeToolkit(
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
	panel = vscode.window.createWebviewPanel("mlsemMergeOverloads", "MLsem: Type toolkit", vscode.ViewColumn.Beside, {
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

	// Apply an edit result to the workspace. On [stale] the binding changed
	// under us → refresh the panel (not an error); otherwise return any genuine
	// error so the caller can surface it.
	async function applyEditResult(result: EditResult): Promise<string | undefined> {
		if (result.ok && result.edits && result.uri) {
			const we = new vscode.WorkspaceEdit();
			const editUri = vscode.Uri.parse(result.uri);
			for (const ed of result.edits) {
				we.replace(
					editUri,
					new vscode.Range(
						new vscode.Position(ed.range.start.line, ed.range.start.character),
						new vscode.Position(ed.range.end.line, ed.range.end.character),
					),
					ed.newText,
				);
			}
			await vscode.workspace.applyEdit(we);
			// Re-fetch so the panel reflects the just-written declarations. The
			// edit may not move the caret (e.g. an instantiation that keeps the
			// same number of [val] lines), so we cannot rely on cursor-follow.
			await refreshCurrent();
			return undefined;
		}
		if (result.stale) {
			await refreshCurrent();
			return undefined;
		}
		return result.error;
	}

	panel.webview.onDidReceiveMessage(async (message: WebviewToExtension) => {
		if (!panel || !client) return;

		if (message.type === "ready") {
			await refreshCurrent();
		} else if (message.type === "requestPreview") {
			// Snapshot the target so cursor-follow retargeting mid-request can't
			// switch which document/binding this reply refers to.
			const uri = currentUri;
			if (!uri) return;
			const result = await client.sendRequest<MergePreviewResult>("mlsem/mergePreview", {
				textDocument: { uri: uri.toString() },
				name: message.name,
				overloadTexts: message.overloadTexts,
				text: textOf(uri),
			});
			panel?.webview.postMessage({ type: "preview", ok: result.ok, text: result.text, error: result.error });
		} else if (message.type === "apply") {
			const uri = currentUri;
			if (!uri) return;
			const result = await client.sendRequest<EditResult>("mlsem/applyMerge", {
				textDocument: { uri: uri.toString() },
				name: message.name,
				overloadTexts: message.overloadTexts,
				text: textOf(uri),
			});
			const applyError = await applyEditResult(result);
			panel?.webview.postMessage({ type: "applied", error: applyError });
		} else if (message.type === "requestInstantiatePreview") {
			const uri = currentUri;
			if (!uri) return;
			const result = await client.sendRequest<InstantiatePreviewResult>("mlsem/instantiatePreview", {
				textDocument: { uri: uri.toString() },
				name: message.name,
				instantiations: message.instantiations,
				text: textOf(uri),
			});
			// A stale preview is silently ignored (the next refresh reconciles);
			// only forward a usable result or a genuine error.
			panel?.webview.postMessage({
				type: "instantiatePreview",
				ok: result.ok,
				overloads: result.overloads,
				error: result.stale ? undefined : result.error,
			});
		} else if (message.type === "applyInstantiate") {
			const uri = currentUri;
			if (!uri) return;
			const result = await client.sendRequest<EditResult>("mlsem/applyInstantiate", {
				textDocument: { uri: uri.toString() },
				name: message.name,
				instantiations: message.instantiations,
				text: textOf(uri),
			});
			const applyError = await applyEditResult(result);
			panel?.webview.postMessage({ type: "instantiated", error: applyError });
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
