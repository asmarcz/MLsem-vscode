// The MLsem language server's mlsem/* requests: what each answers. Distinct
// from the contract between the extension and the toolkit panel
// (protocol.ts).

import type * as lsp from "vscode-languageclient/node";
import type { ExtractLine, PartLine, Precision, ValuePart } from "./protocol";

export interface EditRange {
	start: { line: number; character: number };
	end: { line: number; character: number };
}

export interface TextEdit {
	range: EditRange;
	newText: string;
}

// mlsem/definitionAt: the top-level definition at a position, from the parse
// alone. [line] is its first line, 0-based; [body] is false for val lines
// without a definition.
export type DefinitionAt =
	| { ok: true; name: string; body: boolean; definition: string; line: number }
	| { ok: false; error: string };

// mlsem/definitionStatus: how the definition fares in the file's typecheck.
export type DefinitionStatus =
	| { ok: true; status: "typed"; declared: boolean; types: string[] }
	| { ok: true; status: "errors"; errors: string[] }
	| { ok: true; status: "failed"; message: string }
	| { ok: true; status: "unknown" }
	| { ok: false; error: string };

// mlsem/checkSignature: whether the definition checks against the given
// types; if so, the edit that writes them as its val lines.
export type CheckSignatureResult = { ok: true; edit: TextEdit } | { ok: false; errors?: string[]; error?: string };

// mlsem/overloads.
export interface OverloadsResult {
	found: boolean;
	name: string;
	declared: boolean;
	// With the overloads when they come from the typecheck; from the
	// declarations, they come with mlsem/overloadExtras.
	checked?: boolean;
	body?: boolean;
	overloads: string[];
	overloadVars: string[][];
	concreteTypes: string[];
	callInstances?: RawInstances;
}

// Per overload, the instances its calls use: the assignments of its
// variables and the calls.
export type RawInstances = {
	assignments: { var: string; type: string }[];
	calls: { range: { start: { line: number } }; text: string }[];
}[][];

// mlsem/overloadExtras: what mlsem/overloads leaves out when it answers from
// the declarations.
export interface OverloadExtrasResult {
	ok: boolean;
	checked?: boolean | null;
	callInstances?: RawInstances;
}

// mlsem/mergePreview.
export interface MergePreviewResult {
	ok: boolean;
	text?: string;
	error?: string;
}

// mlsem/generalizePreview.
export interface GeneralizePreviewResult {
	ok: boolean;
	text?: string;
	type?: string;
	precision?: Precision;
	stale?: boolean;
	error?: string;
}

// mlsem/holes.
export interface HolesResult {
	ok: boolean;
	holes?: {
		range: EditRange;
		hole: string;
		// One value, or one per overload of the line's result: as written in
		// place of the hole, with the parts of it that may be kept as holes.
		rows: { overload: string | null; value: string | null; parts: ValuePart[] }[];
		lineText: string;
	}[];
}

// mlsem/extractGroups.
export interface ExtractGroupsResult {
	ok: boolean;
	lines?: ExtractLine[];
}

// mlsem/extractApply.
export interface ExtractApplyResult {
	ok: boolean;
	text?: string;
	decls?: string[];
	linksHoles?: boolean;
	edits?: TextEdit[];
	error?: string;
}

// The edits of a request that changes the document: mlsem/applyMerge,
// mlsem/applyInstantiate.
export interface EditResult {
	ok: boolean;
	uri?: string;
	edits?: TextEdit[];
	stale?: boolean;
	error?: string;
}

// mlsem/subtractDomains.
export interface SubtractResult {
	ok: boolean;
	lines?: string[];
	changed?: number;
	unreachable?: string[];
	maxDepth?: number;
	edits?: TextEdit[];
	stale?: boolean;
	error?: string;
}

// mlsem/instantiatePreview.
export interface InstantiatePreviewResult {
	ok: boolean;
	overloads?: string[];
	stale?: boolean;
	error?: string;
}

// mlsem/widen, mlsem/simplify.
export interface PartsResult {
	ok: boolean;
	error?: string;
	lines?: PartLine[];
}

// mlsem/hoverOverloads: a part of the file an overload row of the hover
// stands for, in the colour of that row's swatch.
export type OverloadRange = { range: lsp.Range; color: string };
