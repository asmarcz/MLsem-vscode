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

// One answer of the LLM: the val lines it proposed (none when it gave no
// val line) and what came of them, with the errors sent back to it.
export interface LlmAttempt {
	vals: string[];
	result: "checks" | "rejected" | "timed out" | "no val line";
	errors?: string[];
}

// Progress of the LLM type inference, whichever way it was started. [tries]
// counts the answers asked for so far; [attempts] are the answers checked so
// far, in order.
export type LlmStatus =
	| { state: "idle" }
	| { state: "running"; name: string; tries: number; maxTries: number; attempts: LlmAttempt[] }
	| {
			state: "done";
			ok: boolean;
			name: string;
			tries: number;
			message: string;
			// The val lines found, or those whose check timed out.
			vals?: string[];
			attempts: LlmAttempt[];
	  };

export function triesText(tries: number) {
	return tries === 1 ? "1 try" : `${tries} tries`;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// A model offered in the type toolkit: one of a provider of
// mlsem.llm.providers through its OpenAI-compatible API, or one of
// mlsem.llm.anthropic through Anthropic's native API, with its effort.
export interface LlmModel {
	api: "openai" | "anthropic";
	provider: string;
	model: string;
	effort?: Effort;
}

// The same model choice. A choice saved before [api] existed is OpenAI.
export function sameModel(a: LlmModel, b: LlmModel) {
	return (
		(a.api ?? "openai") === (b.api ?? "openai") &&
		a.provider === b.provider &&
		a.model === b.model &&
		a.effort === b.effort
	);
}

// How a model is shown in the dropdown, within its provider's group.
export function modelLabel(m: LlmModel) {
	return m.effort ? `${m.model} (effort ${m.effort})` : m.model;
}

export interface LlmSettings {
	// The models of all providers, in order, and the one chosen with its
	// provider's base URL (undefined when there are none, or for Anthropic's
	// native API).
	models: LlmModel[];
	model?: LlmModel;
	baseUrl?: string;
	maxTries: number;
	timeoutCountsAsFail: boolean;
}

export type ExtensionToWebview =
	| {
			type: "overloads";
			found: boolean;
			binding: Binding;
			overloads: Overload[];
			// Concrete-type suggestions for the instantiate comboboxes.
			concreteTypes: string[];
			// Why there is no binding, when the request failed (e.g. the
			// document's typecheck timed out).
			reason?: string;
	  }
	| { type: "preview"; ok: boolean; text?: string; error?: string }
	| { type: "applied"; error?: string }
	| { type: "instantiatePreview"; ok: boolean; overloads?: string[]; error?: string }
	| { type: "instantiated"; error?: string }
	| { type: "llmStatus"; status: LlmStatus }
	| { type: "llmSettings"; settings: LlmSettings }
	// The name of the definition every tool works on, found from the parse so
	// that it may not typecheck; null when the target is not in a definition.
	// Sent before the target's "overloads".
	| { type: "target"; name: string | null };

export type WebviewToExtension =
	| { type: "ready" }
	// Run the LLM type inference on the panel's current target.
	| { type: "inferWithLlm" }
	| { type: "setTimeoutCountsAsFail"; value: boolean }
	| { type: "selectModel"; model: LlmModel }
	| { type: "openLlmSettings" }
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
	llmStatus: true,
	llmSettings: true,
	target: true,
};

// The extension host is a separate process, so what arrives over postMessage is
// untyped at runtime. This is the backstop for anything the shared types cannot
// catch at build time — a stale bundle, or a message from somewhere else.
export function isFromExtension(data: unknown): data is ExtensionToWebview {
	if (typeof data !== "object" || data === null) return false;
	const { type } = data as { type?: unknown };
	return typeof type === "string" && type in EXTENSION_TO_WEBVIEW_TYPES;
}
