// The webview <-> extension message contract, and the shapes carried over it.
//
// Both bundles import this file, so renaming a message on one side is a compile
// error on the other rather than a message nothing handles. It deliberately
// imports nothing: the webview is bundled for the browser and must not pull in
// "vscode". The LSP request/response shapes are a separate contract and stay in
// mergePanel.ts.

export interface Binding {
	name: string;
	declared: boolean;
}

export interface Overload {
	// The rendered signature. This is the overload's identity everywhere — the
	// same one the server matches on — so selections and assignments survive
	// edits and never refer to a stale index.
	text: string;
	// Free type-variable names of this overload.
	vars: string[];
}

// One overload's variable -> concrete-type assignments.
export interface Instantiation {
	overload: string;
	assignments: { var: string; type: string }[];
}

export type ExtensionToWebview =
	| {
			type: "overloads";
			found: boolean;
			binding: Binding;
			overloads: Overload[];
			// Concrete-type suggestions for the instantiate comboboxes.
			concreteTypes: string[];
	  }
	| { type: "preview"; ok: boolean; text?: string; error?: string }
	| { type: "applied"; error?: string }
	| { type: "instantiatePreview"; ok: boolean; overloads?: string[]; error?: string }
	| { type: "instantiated"; error?: string };

export type WebviewToExtension =
	| { type: "ready" }
	| { type: "requestPreview"; name: string; overloadTexts: string[] }
	// [append]: add the result as new declaration line(s) instead of replacing.
	// [keepOthers]: on replace, keep the unselected overloads (scoped Apply)
	// rather than dropping them (full Replace).
	| { type: "apply"; name: string; overloadTexts: string[]; append: boolean; keepOthers: boolean }
	| { type: "requestInstantiatePreview"; name: string; instantiations: Instantiation[] }
	// [only]: restrict the written result to these overload texts (per-overload
	// Insert writes a single one). Absent/undefined means all.
	| {
			type: "applyInstantiate";
			name: string;
			instantiations: Instantiation[];
			append: boolean;
			only?: string[];
	  };

// One key per variant. Adding a message to [ExtensionToWebview] without adding
// it here is a compile error, so the runtime guard cannot fall behind the type.
const EXTENSION_TO_WEBVIEW_TYPES: Record<ExtensionToWebview["type"], true> = {
	overloads: true,
	preview: true,
	applied: true,
	instantiatePreview: true,
	instantiated: true,
};

// The extension host is a separate process, so what arrives over postMessage is
// untyped at runtime. This is the backstop for anything the shared types cannot
// catch at build time — a stale bundle, or a message from somewhere else.
export function isFromExtension(data: unknown): data is ExtensionToWebview {
	if (typeof data !== "object" || data === null) return false;
	const { type } = data as { type?: unknown };
	return typeof type === "string" && type in EXTENSION_TO_WEBVIEW_TYPES;
}
