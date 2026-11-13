// The webview <-> extension message contract, and the shapes carried over it.
//
// Both bundles import this file, so renaming a message on one side is a compile
// error on the other rather than a message nothing handles. It deliberately
// imports nothing: the webview is bundled for the browser and must not pull in
// "vscode". The LSP request/response shapes are a separate contract and stay in
// mergePanel.ts.

// The two ways overload merging combines the selected overloads, previewed
// side by side: collapse them into the smallest single arrow containing them
// (loses precision), or generalize them into a polymorphic type (keeps it,
// but may not check against the definition).
export type MergeMode = "collapse" | "generalize";

// Whether a generalized type checks against the definition, with the errors
// located in it when it does not.
export interface GeneralizeCheck {
	ok: boolean;
	errors: string[];
}

// How a generalized type compares with the overloads it was made from, by
// subtyping both ways (allowing intersections of instances): the same type,
// one that claims more, or one the overloads no longer follow from.
export type Precision = "equivalent" | "stronger" | "weaker";

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
	// The instances of this overload that calls in the document use, in
	// order of first call.
	instances: CallInstance[];
}

// The binding's val lines with the selected overloads' overlap resolved,
// how many changed, and the selected ones the others cover (unreachable).
export interface ResolvePreview {
	lines: string[];
	changed: number;
	unreachable: string[];
}

// A part of a val line's type, at [start, end) of line [line] whose text is
// [lineText] (parentheses around it included), and the wider types for it,
// tightest first, as written in its place.
export interface WidenPart {
	part: string;
	line: number;
	start: number;
	end: number;
	lineText: string;
	candidates: string[];
}

// An instance of an overload: a type per variable, and the calls using it
// (0-based line and the call's text).
export interface CallInstance {
	assignments: { var: string; type: string }[];
	calls: { line: number; text: string }[];
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

// A hole of a draft val line and the type it was resolved to, at
// characters [start, end) of the line.
export interface Hole {
	start: number;
	end: number;
	hole: string;
}

// Values for the holes of a line, in order. A line has one row, or, when
// its check gave several overloads that disagree on its holes, one per
// overload: [overload] is its type, and a value is null where the line
// cannot be that overload.
export interface HoleRow {
	overload?: string;
	values: (string | null)[];
}

// A val line of the target with resolved holes.
export interface HoleLine {
	line: number;
	text: string;
	holes: Hole[];
	rows: HoleRow[];
}

// A part that repeats in a val type: its key (the part, printed), a
// suggested name, how many holes it has, and where each occurrence is in
// the line's text, as [start, end) characters.
export interface ExtractGroup {
	key: string;
	name: string;
	holes: number;
	// A record only part of some records: extracted as a top-level type,
	// each record becoming [{ name with ... }].
	global: boolean;
	occurrences: [number, number][];
}

// A val line of the target, printed, with its repeated parts.
export interface ExtractLine {
	text: string;
	groups: ExtractGroup[];
}

// How a part with holes is extracted: as a plain name, whose copies then
// share the holes, or with a parameter per hole, keeping the meaning.
export type ExtractMode = "plain" | "params";

export interface ExtractChoice {
	key: string;
	name: string;
}

// How the active theme shows a TextMate scope: [fontStyle] as in themes
// ("italic", "bold", "underline", space-separated).
export interface TokenStyle {
	foreground?: string;
	fontStyle?: string;
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
	| {
			type: "preview";
			// Which of the two previews this is.
			mode: MergeMode;
			ok: boolean;
			text?: string;
			error?: string;
			// Generalize only: how the result compares with the overloads, and
			// the result of checking it against the definition.
			precision?: Precision;
			check?: GeneralizeCheck;
	  }
	| { type: "applied"; mode: MergeMode; error?: string }
	| { type: "instantiatePreview"; ok: boolean; overloads?: string[]; error?: string }
	| { type: "instantiated"; error?: string }
	| { type: "llmStatus"; status: LlmStatus }
	| { type: "llmSettings"; settings: LlmSettings }
	// The name of the definition every tool works on, found from the parse so
	// that it may not typecheck; null when the target is not in a definition.
	// Sent before the target's "overloads".
	| { type: "target"; name: string | null }
	// The val lines of the target with resolved holes. Sent after its
	// "overloads".
	| { type: "holes"; lines: HoleLine[] }
	// The val lines of the target with their repeated parts.
	| { type: "extractGroups"; lines: ExtractLine[] }
	// The type of [line] with the chosen parts extracted. [linksHoles]: the
	// plain mode made copies of a part with holes share them.
	| {
			type: "extractPreview";
			line: number;
			mode: ExtractMode;
			ok: boolean;
			text?: string;
			// The top-level type declarations written above the val.
			decls?: string[];
			error?: string;
			linksHoles?: boolean;
	  }
	| { type: "extracted"; error?: string }
	// The part of a val line's type at the editor's selection or cursor, and
	// the wider types for it; or why there is none.
	| { type: "widen"; part: WidenPart | null; reason?: string }
	| { type: "widened"; error?: string }
	// The selected overloads with their overlap resolved.
	| { type: "resolvePreview"; ok: boolean; preview?: ResolvePreview; error?: string }
	| { type: "resolved"; error?: string }
	// From the panel's title bar buttons.
	| { type: "setAllCollapsed"; collapsed: boolean }
	// The active theme's style for each scope of the MLsem grammar. Sent on
	// open and whenever the theme or its customizations change.
	| { type: "tokenColors"; colors: Record<string, TokenStyle> };

export type WebviewToExtension =
	| { type: "ready" }
	// Run the LLM type inference on the panel's current target.
	| { type: "inferWithLlm" }
	| { type: "setTimeoutCountsAsFail"; value: boolean }
	// Replace holes of the target's val lines with their types: those given
	// by line, row of values and start character, or all those of lines
	// with a single row.
	| { type: "fillHoles"; holes?: { line: number; row: number; start: number }[] }
	// Preview, or write, the type of val line [line] of the target with the
	// chosen parts extracted.
	| { type: "requestExtractPreview"; line: number; mode: ExtractMode; groups: ExtractChoice[] }
	| { type: "applyExtract"; line: number; mode: ExtractMode; groups: ExtractChoice[] }
	// Replace the widen tool's part with [text].
	| { type: "applyWiden"; text: string }
	// Preview, or write, the selected overloads with their overlap resolved.
	| { type: "requestResolve"; name: string; overloadTexts: string[] }
	| { type: "applyResolve"; name: string; overloadTexts: string[] }
	| { type: "selectModel"; model: LlmModel }
	| { type: "openLlmSettings" }
	| { type: "requestPreview"; name: string; overloadTexts: string[]; mode: MergeMode }
	// [append]: add the result as new declaration line(s) instead of replacing.
	// [keepOthers]: on replace, keep the unselected overloads (scoped Apply)
	// rather than dropping them (full Replace). [overloads]: every overload, in
	// order, which generalize writes back around its result.
	| {
			type: "apply";
			name: string;
			overloadTexts: string[];
			append: boolean;
			keepOthers: boolean;
			mode: MergeMode;
			overloads: string[];
	  }
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
	holes: true,
	extractGroups: true,
	extractPreview: true,
	extracted: true,
	widen: true,
	widened: true,
	resolvePreview: true,
	resolved: true,
	setAllCollapsed: true,
	tokenColors: true,
};

// The extension host is a separate process, so what arrives over postMessage is
// untyped at runtime. This is the backstop for anything the shared types cannot
// catch at build time — a stale bundle, or a message from somewhere else.
export function isFromExtension(data: unknown): data is ExtensionToWebview {
	if (typeof data !== "object" || data === null) return false;
	const { type } = data as { type?: unknown };
	return typeof type === "string" && type in EXTENSION_TO_WEBVIEW_TYPES;
}
