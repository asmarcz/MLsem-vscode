import * as vscode from "vscode";
import type * as lsp from "vscode-languageclient/node";
import type { LanguageClient } from "vscode-languageclient/node";

// A part of the file an overload row of the hover stands for, in the colour of
// that row's swatch.
type OverloadRange = { range: lsp.Range; color: string };

// While a hover on an overloaded variable is shown, tints the parts of the
// file its overload rows stand for, in the colours of the rows' swatches.
//
// VS Code has no event for a hover closing. The tint is replaced by the next
// hover (moving the mouse elsewhere asks for one) and cleared when the cursor,
// the text or the active editor changes.
export class OverloadColors implements vscode.Disposable {
	private readonly types = new Map<string, vscode.TextEditorDecorationType>();
	private readonly listeners: vscode.Disposable[];
	// Only the latest hover's answer is applied.
	private latest = 0;

	constructor(
		private readonly client: () => LanguageClient | undefined,
		private readonly enabled: () => boolean,
	) {
		this.listeners = [
			vscode.window.onDidChangeTextEditorSelection(() => this.clear()),
			vscode.workspace.onDidChangeTextDocument(() => this.clear()),
			vscode.window.onDidChangeActiveTextEditor(() => this.clear()),
		];
	}

	async afterHover(document: vscode.TextDocument, position: vscode.Position): Promise<void> {
		const request = ++this.latest;
		const client = this.client();
		if (!this.enabled() || !client) {
			this.clear();
			return;
		}
		let ranges: OverloadRange[];
		try {
			ranges = await client.sendRequest<OverloadRange[]>("mlsem/hoverOverloads", {
				textDocument: { uri: document.uri.toString() },
				position: client.code2ProtocolConverter.asPosition(position),
			});
		} catch {
			ranges = [];
		}
		if (request !== this.latest) {
			return;
		}
		const byColor = new Map<string, vscode.Range[]>();
		for (const { range, color } of ranges) {
			const list = byColor.get(color) ?? [];
			list.push(client.protocol2CodeConverter.asRange(range));
			byColor.set(color, list);
		}
		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document !== document) {
				continue;
			}
			for (const [color, type] of this.types) {
				editor.setDecorations(type, byColor.get(color) ?? []);
			}
			for (const [color, list] of byColor) {
				editor.setDecorations(this.type(color), list);
			}
		}
	}

	clear(): void {
		this.latest++;
		for (const editor of vscode.window.visibleTextEditors) {
			for (const type of this.types.values()) {
				editor.setDecorations(type, []);
			}
		}
	}

	dispose(): void {
		for (const l of this.listeners) {
			l.dispose();
		}
		for (const type of this.types.values()) {
			type.dispose();
		}
		this.types.clear();
	}

	private type(color: string): vscode.TextEditorDecorationType {
		let type = this.types.get(color);
		if (!type) {
			// The server sends opaque #rrggbb colours for the swatches; the text
			// stays readable under a translucent tint of the same colour.
			type = vscode.window.createTextEditorDecorationType({
				backgroundColor: `${color}40`,
				overviewRulerColor: color,
				overviewRulerLane: vscode.OverviewRulerLane.Right,
			});
			this.types.set(color, type);
		}
		return type;
	}
}
