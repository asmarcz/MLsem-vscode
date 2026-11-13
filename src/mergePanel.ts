import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import { Config } from "./config";
import { allModels, llmStatus, onLlmStatus, selectedModel, selectModel } from "./llm";
import type {
	ExtensionToWebview,
	ExtractChoice,
	ExtractLine,
	ExtractMode,
	HoleLine,
	Precision,
	WebviewToExtension,
} from "./protocol";
import { tokenColors } from "./themeColors";

// --- LSP server contract (distinct from the webview contract in protocol.ts) ---

interface OverloadsResult {
	found: boolean;
	name: string;
	declared: boolean;
	overloads: string[];
	overloadVars: string[][];
	concreteTypes: string[];
	callInstances?: {
		assignments: { var: string; type: string }[];
		calls: { range: { start: { line: number } }; text: string }[];
	}[][];
}

interface MergePreviewResult {
	ok: boolean;
	text?: string;
	error?: string;
}

interface GeneralizePreviewResult {
	ok: boolean;
	text?: string;
	type?: string;
	precision?: Precision;
	stale?: boolean;
	error?: string;
}

interface CheckSignatureResult {
	ok: boolean;
	edit?: { range: EditRange; newText: string };
	errors?: string[];
	error?: string;
}

interface EditRange {
	start: { line: number; character: number };
	end: { line: number; character: number };
}

interface HolesResult {
	ok: boolean;
	holes?: {
		range: EditRange;
		hole: string;
		// One value, or one per overload of the line's result.
		rows: { overload: string | null; value: string | null }[];
		lineText: string;
	}[];
}

interface ExtractGroupsResult {
	ok: boolean;
	lines?: ExtractLine[];
}

interface ExtractApplyResult {
	ok: boolean;
	text?: string;
	decls?: string[];
	linksHoles?: boolean;
	edits?: { range: EditRange; newText: string }[];
	error?: string;
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

// The panel, with [postMessage] narrowed to our protocol. VS Code declares it
// as postMessage(message: any), and an existing member cannot be narrowed by
// module augmentation — an added overload merges alongside the `any` one and
// changes nothing — so the member is replaced here instead. Narrowing the
// variable rather than routing sends through a helper means there is no
// untyped postMessage left in this file to reach for by accident.
type TypedWebview = Omit<vscode.Webview, "postMessage"> & {
	postMessage(message: ExtensionToWebview): Thenable<boolean>;
};
type TypedPanel = Omit<vscode.WebviewPanel, "webview"> & { webview: TypedWebview };

let panel: TypedPanel | undefined;
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

// The overloads of the binding at [position], or why there are none when the
// request fails: the server refuses or gives up on a document whose
// typecheck times out.
async function fetchOverloads(
	uri: vscode.Uri,
	position: vscode.Position,
): Promise<OverloadsResult | { failed: string } | undefined> {
	if (!client) return undefined;
	try {
		return await client.sendRequest<OverloadsResult>("mlsem/overloads", {
			textDocument: { uri: uri.toString() },
			position: { line: position.line, character: position.character },
			text: textOf(uri),
		});
	} catch (e) {
		return { failed: e instanceof Error ? e.message : String(e) };
	}
}

function postOverloads(result: OverloadsResult | { failed: string }): void {
	if ("failed" in result) {
		panel?.webview.postMessage({
			type: "overloads",
			found: false,
			binding: { name: "", declared: false },
			overloads: [],
			concreteTypes: [],
			reason: result.failed,
		});
		return;
	}
	panel?.webview.postMessage({
		type: "overloads",
		found: result.found,
		binding: { name: result.name, declared: result.declared },
		// The server sends signatures and their free type variables as two
		// parallel arrays; zip them here so the webview never has to keep an
		// index alignment in sync with a list it otherwise addresses by text.
		overloads: result.overloads.map((text, i) => ({
			text,
			vars: result.overloadVars[i] ?? [],
			instances: (result.callInstances?.[i] ?? []).map(({ assignments, calls }) => ({
				assignments,
				calls: calls.map(({ range, text }) => ({ line: range.start.line, text })),
			})),
		})),
		concreteTypes: result.concreteTypes,
	});
}

// The top-level definition at [position], from the parse alone, so it is
// found whether or not the definition typechecks. Undefined when there is
// none (blank lines, comments, type definitions).
async function definitionAt(uri: vscode.Uri, position: vscode.Position): Promise<string | undefined> {
	if (!client) return undefined;
	try {
		const result = await client.sendRequest<{ ok: boolean; name?: string }>("mlsem/definitionAt", {
			textDocument: { uri: uri.toString() },
			position: { line: position.line, character: position.character },
			text: textOf(uri),
		});
		return result.ok ? result.name : undefined;
	} catch {
		return undefined;
	}
}

// The selected overloads of [name] generalized into one polymorphic type.
async function generalize(uri: vscode.Uri, name: string, overloadTexts: string[]): Promise<GeneralizePreviewResult> {
	if (!client) return { ok: false, error: "The MLsem server is not running." };
	try {
		const result = await client.sendRequest<GeneralizePreviewResult>("mlsem/generalizePreview", {
			textDocument: { uri: uri.toString() },
			name,
			overloadTexts,
			text: textOf(uri),
		});
		return result.stale ? { ok: false, error: "The types changed; select the overloads again." } : result;
	} catch (e) {
		return { ok: false, error: String(e) };
	}
}

// Check [types] as the declarations of the definition at [position]. On
// success the result carries the edit that writes them.
async function checkTypes(uri: vscode.Uri, position: vscode.Position, types: string[]): Promise<CheckSignatureResult> {
	if (!client) return { ok: false, error: "The MLsem server is not running." };
	try {
		return await client.sendRequest<CheckSignatureResult>("mlsem/checkSignature", {
			textDocument: { uri: uri.toString() },
			position: { line: position.line, character: position.character },
			text: textOf(uri),
			types,
		});
	} catch (e) {
		return { ok: false, error: String(e) };
	}
}

// The resolved holes of the val lines of the definition at [position],
// grouped by line. A hole spanning lines is left out: the view shows one
// line at a time.
async function fetchHoles(uri: vscode.Uri, position: vscode.Position): Promise<HoleLine[]> {
	if (!client) return [];
	let result: HolesResult;
	try {
		result = await client.sendRequest<HolesResult>("mlsem/holes", {
			textDocument: { uri: uri.toString() },
			position: { line: position.line, character: position.character },
			text: textOf(uri),
		});
	} catch {
		return [];
	}
	type Raw = NonNullable<HolesResult["holes"]>[number];
	const byLine = new Map<number, { text: string; holes: Raw[] }>();
	for (const h of result.holes ?? []) {
		const line = h.range.start.line;
		if (h.range.end.line !== line) continue;
		const entry = byLine.get(line) ?? { text: h.lineText, holes: [] };
		entry.holes.push(h);
		byLine.set(line, entry);
	}
	// A line's rows: one per overload of its result if a hole has values per
	// overload, a hole with a single value repeating it in each.
	return [...byLine.entries()].map(([line, { text, holes }]) => {
		const widest = holes.reduce((a, h) => (h.rows.length > a.rows.length ? h : a), holes[0]);
		const rows = widest.rows.map((r, k) => ({
			overload: r.overload ?? undefined,
			values: holes.map((h) => (h.rows.length === widest.rows.length ? h.rows[k] : h.rows[0])?.value ?? null),
		}));
		return {
			line,
			text,
			holes: holes.map((h) => ({ start: h.range.start.character, end: h.range.end.character, hole: h.hole })),
			rows,
		};
	});
}

// The repeated parts of the val lines of the definition at [position].
async function fetchExtractGroups(uri: vscode.Uri, position: vscode.Position): Promise<ExtractLine[]> {
	if (!client) return [];
	try {
		const result = await client.sendRequest<ExtractGroupsResult>("mlsem/extractGroups", {
			textDocument: { uri: uri.toString() },
			position: { line: position.line, character: position.character },
			text: textOf(uri),
		});
		return result.lines ?? [];
	} catch {
		return [];
	}
}

// Val line [line] of the definition at [position] with the chosen parts
// extracted, and the edit that writes it.
async function extractApply(
	uri: vscode.Uri,
	position: vscode.Position,
	line: number,
	mode: ExtractMode,
	groups: ExtractChoice[],
): Promise<ExtractApplyResult> {
	if (!client) return { ok: false, error: "The MLsem server is not running." };
	try {
		return await client.sendRequest<ExtractApplyResult>("mlsem/extractApply", {
			textDocument: { uri: uri.toString() },
			position: { line: position.line, character: position.character },
			text: textOf(uri),
			line,
			plumbing: mode === "params",
			groups,
		});
	} catch (e) {
		return { ok: false, error: String(e) };
	}
}

// The holes last posted to the panel, which "fillHoles" replaces.
let currentHoles: HoleLine[] = [];

// Re-fetch the panel's target and post it to every tool, whatever it is —
// used for explicit (re)opens and refreshes, where "nothing here" is useful
// feedback. The target's name is posted first: the overloads need the
// document's typecheck, which may take until it times out, and the LLM tool
// does not wait for them.
async function refreshCurrent(): Promise<void> {
	if (!panel || !currentUri || !currentPosition) return;
	const uri = currentUri;
	const position = currentPosition;
	const name = await definitionAt(uri, position);
	panel?.webview.postMessage({ type: "target", name: name ?? null });
	// From the parse alone, so before the overloads, which wait for the
	// typecheck.
	panel?.webview.postMessage({ type: "extractGroups", lines: name ? await fetchExtractGroups(uri, position) : [] });
	const overloads = await fetchOverloads(uri, position);
	if (overloads) postOverloads(overloads);
	// After the overloads: the holes come from the typecheck they waited for.
	currentHoles = name ? await fetchHoles(uri, position) : [];
	panel?.webview.postMessage({ type: "holes", lines: currentHoles });
}

// Follow the editor cursor: retarget the panel to the definition under
// [position], typeable or not, but only when there is one, so clicking off a
// definition keeps the current panel content instead of blanking it.
async function followCursor(uri: vscode.Uri, position: vscode.Position): Promise<void> {
	if (!panel) return;
	if ((await definitionAt(uri, position)) === undefined) return;
	currentUri = uri;
	currentPosition = position;
	await refreshCurrent();
}

// Collapse or expand every tool of the panel, if it is open.
export function setAllToolsCollapsed(collapsed: boolean): void {
	panel?.webview.postMessage({ type: "setAllCollapsed", collapsed });
}

export function openTypeToolkit(
	context: vscode.ExtensionContext,
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

	panel.webview.html = getHtml(panel.webview, context.extensionUri, nonce);

	const saveSubscription = vscode.workspace.onDidSaveTextDocument((doc) => {
		if (currentUri && doc.uri.toString() === currentUri.toString()) {
			refreshCurrent();
		}
	});

	// While the panel is open, follow the cursor in any MLsem editor so that
	// clicking a definition loads it into every tool. Debounced so
	// drag-selection and rapid caret moves don't spam the server.
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

	const config = new Config();
	function postLlmSettings() {
		const chosen = selectedModel(context, config);
		panel?.webview.postMessage({
			type: "llmSettings",
			settings: {
				models: allModels(config),
				model: chosen && { api: chosen.api, provider: chosen.provider, model: chosen.model, effort: chosen.effort },
				baseUrl: chosen?.baseUrl,
				maxTries: config.llmMaxTries,
				timeoutCountsAsFail: config.llmTimeoutCountsAsFail,
			},
		});
	}
	// The theme's colours for MLsem's scopes, for highlighting as in the editor.
	function postTokenColors() {
		let colors = {};
		try {
			colors = tokenColors(context.extensionPath);
		} catch {
			// Unreadable theme: the panel shows plain text.
		}
		panel?.webview.postMessage({ type: "tokenColors", colors });
	}
	const llmSubscriptions = [
		onLlmStatus((status) => panel?.webview.postMessage({ type: "llmStatus", status })),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("mlsem.llm")) postLlmSettings();
			if (
				e.affectsConfiguration("workbench") ||
				e.affectsConfiguration("window.autoDetectColorScheme") ||
				e.affectsConfiguration("window.autoDetectHighContrast") ||
				e.affectsConfiguration("editor.tokenColorCustomizations")
			)
				postTokenColors();
		}),
		vscode.window.onDidChangeActiveColorTheme(() => postTokenColors()),
	];

	panel.webview.onDidReceiveMessage(async (message: WebviewToExtension) => {
		if (!panel || !client) return;

		if (message.type === "ready") {
			postTokenColors();
			postLlmSettings();
			panel.webview.postMessage({ type: "llmStatus", status: llmStatus() });
			await refreshCurrent();
		} else if (message.type === "inferWithLlm") {
			if (!currentUri || !currentPosition) return;
			await vscode.commands.executeCommand("mlsem.inferTypeWithLlm", currentUri, currentPosition);
			await refreshCurrent();
		} else if (message.type === "fillHoles") {
			const uri = currentUri;
			if (!uri) return;
			const we = new vscode.WorkspaceEdit();
			// The row of values to fill line [l] from, for its hole at [start]:
			// the one asked for, or, filling all, the line's only row.
			const rowOf = (l: HoleLine, start: number) =>
				message.holes === undefined
					? l.rows.length === 1
						? 0
						: undefined
					: message.holes.find((h) => h.line === l.line && h.start === start)?.row;
			for (const l of currentHoles) {
				l.holes.forEach((h, i) => {
					const row = rowOf(l, h.start);
					const value = row === undefined ? null : l.rows[row]?.values[i];
					if (value) we.replace(uri, new vscode.Range(l.line, h.start, l.line, h.end), value);
				});
			}
			await vscode.workspace.applyEdit(we);
			await refreshCurrent();
		} else if (message.type === "requestExtractPreview") {
			if (!currentUri || !currentPosition) return;
			const r = await extractApply(currentUri, currentPosition, message.line, message.mode, message.groups);
			panel?.webview.postMessage({
				type: "extractPreview",
				line: message.line,
				mode: message.mode,
				ok: r.ok,
				text: r.text,
				decls: r.decls,
				error: r.error,
				linksHoles: r.linksHoles,
			});
		} else if (message.type === "applyExtract") {
			const uri = currentUri;
			if (!uri || !currentPosition) return;
			const r = await extractApply(uri, currentPosition, message.line, message.mode, message.groups);
			const error = r.edits
				? await applyEditResult({ ok: true, uri: uri.toString(), edits: r.edits })
				: (r.error ?? "Could not extract.");
			panel?.webview.postMessage({ type: "extracted", error });
		} else if (message.type === "setTimeoutCountsAsFail") {
			await config.setLlmTimeoutCountsAsFail(message.value);
		} else if (message.type === "selectModel") {
			await selectModel(context, message.model);
			postLlmSettings();
		} else if (message.type === "openLlmSettings") {
			await vscode.commands.executeCommand("workbench.action.openSettings", "mlsem.llm");
		} else if (message.type === "requestPreview") {
			// Snapshot the target so cursor-follow retargeting mid-request can't
			// switch which document/binding this reply refers to.
			const uri = currentUri;
			const position = currentPosition;
			if (!uri || !position) return;
			if (message.mode === "generalize") {
				const g = await generalize(uri, message.name, message.overloadTexts);
				if (!g.ok || g.type === undefined) {
					panel?.webview.postMessage({ type: "preview", mode: "generalize", ok: false, error: g.error });
					return;
				}
				const check = await checkTypes(uri, position, [g.type]);
				panel?.webview.postMessage({
					type: "preview",
					mode: "generalize",
					ok: true,
					text: g.text,
					precision: g.precision,
					check: { ok: check.ok, errors: check.errors ?? (check.error ? [check.error] : []) },
				});
				return;
			}
			const result = await client.sendRequest<MergePreviewResult>("mlsem/mergePreview", {
				textDocument: { uri: uri.toString() },
				name: message.name,
				overloadTexts: message.overloadTexts,
				text: textOf(uri),
			});
			panel?.webview.postMessage({
				type: "preview",
				mode: "collapse",
				ok: result.ok,
				text: result.text,
				error: result.error,
			});
		} else if (message.type === "apply" && message.mode === "generalize") {
			// The generalized type is written through mlsem/checkSignature's edit,
			// even when it does not check: the user may refine it further.
			const uri = currentUri;
			const position = currentPosition;
			if (!uri || !position) return;
			const g = await generalize(uri, message.name, message.overloadTexts);
			if (!g.ok || g.type === undefined) {
				panel?.webview.postMessage({
					type: "applied",
					mode: "generalize",
					error: g.error ?? "Could not generalize.",
				});
				return;
			}
			const types = message.append
				? [...message.overloads, g.type]
				: message.keepOthers
					? [g.type, ...message.overloads.filter((o) => !message.overloadTexts.includes(o))]
					: [g.type];
			const check = await checkTypes(uri, position, types);
			const applyError = check.edit
				? await applyEditResult({ ok: true, uri: uri.toString(), edits: [check.edit] })
				: (check.error ?? "Could not write the generalized type.");
			panel?.webview.postMessage({ type: "applied", mode: "generalize", error: applyError });
		} else if (message.type === "apply") {
			const uri = currentUri;
			if (!uri) return;
			const result = await client.sendRequest<EditResult>("mlsem/applyMerge", {
				textDocument: { uri: uri.toString() },
				name: message.name,
				overloadTexts: message.overloadTexts,
				append: message.append,
				keepOthers: message.keepOthers,
				text: textOf(uri),
			});
			const applyError = await applyEditResult(result);
			panel?.webview.postMessage({ type: "applied", mode: "collapse", error: applyError });
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
				append: message.append,
				only: message.only,
				text: textOf(uri),
			});
			const applyError = await applyEditResult(result);
			panel?.webview.postMessage({ type: "instantiated", error: applyError });
		}
	});

	panel.onDidDispose(() => {
		saveSubscription.dispose();
		selectionSubscription.dispose();
		for (const s of llmSubscriptions) s.dispose();
		if (followTimer) clearTimeout(followTimer);
		followTimer = undefined;
		panel = undefined;
		currentUri = undefined;
		currentPosition = undefined;
	});
}
