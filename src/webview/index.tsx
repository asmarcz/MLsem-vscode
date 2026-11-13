import { type ComponentChildren, render } from "preact";
import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import {
	type Binding,
	type CallInstance,
	type ExtensionToWebview,
	type ExtractChoice,
	type ExtractLine,
	type ExtractMode,
	type GeneralizeCheck,
	type HoleLine,
	type Instantiation,
	isFromExtension,
	type LlmAttempt,
	type LlmSettings,
	type LlmStatus,
	type MergeMode,
	modelLabel,
	type Overload,
	type PartLine,
	type PartTool,
	type Precision,
	type SubtractPreview,
	sameModel,
	type TokenStyle,
	type TypePart,
	triesText,
	type WebviewToExtension,
} from "../protocol";
import { Code, TokenColors } from "./highlight";
import css from "./styles.css";

declare function acquireVsCodeApi(): {
	postMessage(msg: WebviewToExtension): void;
	getState(): AppState | undefined;
	setState(state: AppState): void;
};

const vscodeApi = acquireVsCodeApi();

// Per-overload (keyed by rendered text) map of variable name -> chosen concrete
// type string. Variables are independent per overload, so they are never shared
// across keys.
type Assignments = Record<string, Record<string, string>>;

// Both tools have the same lifecycle — request a preview, apply it, report an
// error — so they share a shape instead of two prefixed copies of these four
// fields. [P] is what the tool previews: merge yields one line, instantiate a
// line per overload.
interface ToolState<P> {
	preview: P | null;
	applying: boolean;
	// Set when a refresh dropped part of the input, so the tool can say the
	// types changed underneath it.
	stale: boolean;
	error: string | null;
}

const initialToolState = { preview: null, applying: false, stale: false, error: null };

interface AppState {
	found: boolean;
	binding: Binding | null;
	overloads: Overload[];
	// Concrete-type suggestions for the instantiate comboboxes.
	concreteTypes: string[];
	// Overload texts picked for merging.
	selected: string[];
	// The two ways of merging the selected overloads, previewed side by side,
	// and domain subtraction on them.
	merge: ToolState<string>;
	generalize: ToolState<string>;
	subtract: ToolState<SubtractPreview>;
	// What came with the generalize preview: how it compares with the
	// overloads, and whether the type checks.
	generalized: { precision: Precision | null; check: GeneralizeCheck } | null;
	assignments: Assignments;
	instantiate: ToolState<string[]>;
	llmSettings: LlmSettings | null;
	llmStatus: LlmStatus;
	// The definition every tool works on, typeable or not; null when the
	// panel's target is not in a definition. When it typechecks, [binding] is
	// its binding.
	target: string | null;
	// Why the overload tools have no binding, when the request failed.
	overloadsFailure: string | null;
	// The target's val lines with resolved holes, and the holes picked for
	// Fill, by [holeKey].
	holes: HoleLine[];
	selectedHoles: string[];
	extract: ExtractState;
	// Per part tool, the target's val lines with the parts it has options
	// for, or why there are none.
	parts: Record<PartTool, PartsState>;
	// The editor theme's style for each MLsem scope, for highlighting.
	tokenColors: Record<string, TokenStyle>;
	// Collapsed sections, by id. Kept across bindings, like VS Code's panes.
	collapsed: Record<SectionId, boolean>;
}

// The extract tool: the target's val lines with their repeated parts; per
// line, the parts chosen (by key); the names given, by [extractKey]; and
// the previews, by line and mode.
interface ExtractState {
	lines: ExtractLine[];
	chosen: Record<number, string[]>;
	names: Record<string, string>;
	previews: Record<string, { ok: boolean; text?: string; decls?: string[]; error?: string; linksHoles?: boolean }>;
	applying: boolean;
	error: string | null;
}

const initialExtract: ExtractState = { lines: [], chosen: {}, names: {}, previews: {}, applying: false, error: null };

function extractKey(line: number, key: string) {
	return `${line}\n${key}`;
}

// A part tool: the lines from the server, or why there are none, and its
// apply in flight and error.
interface PartsState {
	lines: PartLine[];
	reason: string | null;
	applying: boolean;
	error: string | null;
}

const initialParts: PartsState = { lines: [], reason: null, applying: false, error: null };

type SectionId = "holes" | "extract" | "widen" | "simplify" | "merge" | "instantiate" | "llm";

const SECTION_IDS: SectionId[] = ["holes", "extract", "widen", "simplify", "merge", "instantiate", "llm"];

type Action =
	| ExtensionToWebview // "overloads", "preview" etc. are dispatched directly
	| { type: "TOGGLE_SECTION"; id: SectionId }
	| { type: "TOGGLE"; text: string }
	| { type: "TOGGLE_HOLE"; line: number; row: number; start: number }
	| { type: "TOGGLE_EXTRACT"; line: number; key: string }
	| { type: "SET_EXTRACT_NAME"; line: number; key: string; name: string }
	| { type: "EXTRACT_APPLYING" }
	| { type: "PARTS_APPLYING"; tool: PartTool }
	| { type: "APPLYING"; mode: MergeMode }
	| { type: "SUBTRACT_APPLYING" }
	| { type: "SET_ASSIGNMENT"; overload: string; variable: string; value: string }
	| { type: "SET_ASSIGNMENTS"; overload: string; values: Record<string, string> }
	| { type: "INST_APPLYING" }
	| { type: "INST_CLEAR_PREVIEW" };

const initialState: AppState = {
	found: false,
	binding: null,
	overloads: [],
	concreteTypes: [],
	selected: [],
	merge: initialToolState,
	generalize: initialToolState,
	subtract: initialToolState,
	generalized: null,
	assignments: {},
	instantiate: initialToolState,
	llmSettings: null,
	llmStatus: { state: "idle" },
	target: null,
	overloadsFailure: null,
	holes: [],
	selectedHoles: [],
	extract: initialExtract,
	parts: { widen: initialParts, simplify: initialParts },
	tokenColors: {},
	collapsed: {
		holes: false,
		extract: false,
		widen: false,
		simplify: false,
		merge: false,
		instantiate: false,
		llm: false,
	},
};

// Drop assignment entries for overloads that no longer exist; report whether
// anything was dropped (so the instantiate tool can show a "types changed" note).
function reconcileAssignments(prev: Assignments, texts: Set<string>): { kept: Assignments; dropped: boolean } {
	const kept: Assignments = {};
	let dropped = false;
	for (const [text, vars] of Object.entries(prev)) {
		if (texts.has(text)) kept[text] = vars;
		else dropped = true;
	}
	return { kept, dropped };
}

// A preview reply: the value on success, the error on failure — never both.
// Serves "preview" and "instantiatePreview" alike.
function withPreview<P>(
	tool: ToolState<P>,
	ok: boolean,
	value: P | undefined,
	error: string | undefined,
): ToolState<P> {
	return { ...tool, preview: ok ? (value ?? null) : null, error: ok ? null : (error ?? null) };
}

// An apply reply: the edit is done, whether or not it worked.
function withApplied<P>(tool: ToolState<P>, error: string | undefined): ToolState<P> {
	return { ...tool, applying: false, error: error ?? null };
}

function reducer(state: AppState, action: Action): AppState {
	switch (action.type) {
		case "overloads": {
			if (!action.found) {
				// The LLM section and the collapsed sections do not depend on the
				// binding.
				return {
					...initialState,
					found: false,
					binding: action.binding,
					llmSettings: state.llmSettings,
					llmStatus: state.llmStatus,
					target: state.target,
					overloadsFailure: action.reason ?? null,
					// From the parse, sent before the overloads.
					extract: state.extract,
					// Not about the binding.
					parts: state.parts,
					tokenColors: state.tokenColors,
					collapsed: state.collapsed,
				};
			}
			const sameBinding = state.found && state.binding?.name === action.binding?.name;
			const texts = new Set(action.overloads.map((o) => o.text));
			// Merge: keep selections whose overload text still exists.
			const kept = sameBinding ? state.selected.filter((t) => texts.has(t)) : [];
			// Instantiate: keep assignments for overloads that still exist.
			const { kept: assignments, dropped } = sameBinding
				? reconcileAssignments(state.assignments, texts)
				: { kept: {}, dropped: false };
			// [applying] deliberately survives: the extension refreshes the panel
			// before it reports the apply finished, so this message arrives while
			// an edit is still in flight.
			return {
				...state,
				found: true,
				overloadsFailure: null,
				binding: action.binding,
				overloads: action.overloads,
				concreteTypes: action.concreteTypes,
				selected: kept,
				merge: { ...state.merge, preview: null, stale: kept.length < state.selected.length, error: null },
				generalize: { ...state.generalize, preview: null, error: null },
				subtract: { ...state.subtract, preview: null, error: null },
				generalized: null,
				assignments,
				instantiate: { ...state.instantiate, preview: null, stale: dropped, error: null },
			};
		}
		case "TOGGLE_SECTION":
			return { ...state, collapsed: { ...state.collapsed, [action.id]: !state.collapsed[action.id] } };
		case "tokenColors":
			return { ...state, tokenColors: action.colors };
		case "setAllCollapsed":
			return {
				...state,
				collapsed: Object.fromEntries(SECTION_IDS.map((id) => [id, action.collapsed])) as AppState["collapsed"],
			};
		case "parts": {
			// [applying] survives: the extension refreshes before it reports the
			// edit done.
			const p = state.parts[action.tool];
			const next = { ...p, lines: action.lines, reason: action.reason ?? null, error: null };
			return { ...state, parts: { ...state.parts, [action.tool]: next } };
		}
		case "PARTS_APPLYING": {
			const next = { ...state.parts[action.tool], applying: true, error: null };
			return { ...state, parts: { ...state.parts, [action.tool]: next } };
		}
		case "partsApplied": {
			const next = { ...state.parts[action.tool], applying: false, error: action.error ?? null };
			return { ...state, parts: { ...state.parts, [action.tool]: next } };
		}
		case "llmSettings":
			return { ...state, llmSettings: action.settings };
		case "llmStatus":
			return { ...state, llmStatus: action.status };
		case "target":
			return { ...state, target: action.name };
		case "holes": {
			// Keep the selection of holes that are still there.
			const keys = action.lines.flatMap((l) =>
				l.rows.flatMap((_, row) => l.holes.map((h) => holeKey(l.line, row, h.start))),
			);
			return { ...state, holes: action.lines, selectedHoles: state.selectedHoles.filter((k) => keys.includes(k)) };
		}
		case "extractGroups": {
			// Keep the choices and names of parts that are still there, by line.
			const ex = state.extract;
			const chosen: Record<number, string[]> = {};
			const names: Record<string, string> = {};
			action.lines.forEach((l, i) => {
				const keys = l.groups.map((g) => g.key);
				chosen[i] = (ex.chosen[i] ?? []).filter((k) => keys.includes(k));
				for (const g of l.groups) {
					const k = extractKey(i, g.key);
					names[k] = ex.names[k] ?? g.name;
				}
			});
			return { ...state, extract: { ...ex, lines: action.lines, chosen, names, previews: {}, error: null } };
		}
		case "TOGGLE_EXTRACT": {
			const ex = state.extract;
			const cur = ex.chosen[action.line] ?? [];
			const next = cur.includes(action.key) ? cur.filter((k) => k !== action.key) : [...cur, action.key];
			return { ...state, extract: { ...ex, chosen: { ...ex.chosen, [action.line]: next }, error: null } };
		}
		case "SET_EXTRACT_NAME": {
			const ex = state.extract;
			const names = { ...ex.names, [extractKey(action.line, action.key)]: action.name };
			return { ...state, extract: { ...ex, names } };
		}
		case "extractPreview": {
			const ex = state.extract;
			const { ok, text, decls, error, linksHoles } = action;
			const previews = { ...ex.previews, [`${action.line}:${action.mode}`]: { ok, text, decls, error, linksHoles } };
			return { ...state, extract: { ...ex, previews } };
		}
		case "EXTRACT_APPLYING":
			return { ...state, extract: { ...state.extract, applying: true, error: null } };
		case "extracted":
			return { ...state, extract: { ...state.extract, applying: false, error: action.error ?? null } };
		case "TOGGLE_HOLE": {
			// A named hole ('_a) is one variable: its occurrences on the line
			// are picked together, within the row.
			const line = state.holes.find((l) => l.line === action.line);
			const hole = line?.holes.find((h) => h.start === action.start);
			if (!line || !hole) return state;
			const group = line.holes
				.filter((h) => h.start === hole.start || (hole.hole !== "_" && h.hole === hole.hole))
				.map((h) => holeKey(line.line, action.row, h.start));
			const on = state.selectedHoles.includes(holeKey(line.line, action.row, hole.start));
			const rest = state.selectedHoles.filter((k) => !group.includes(k));
			return { ...state, selectedHoles: on ? rest : [...rest, ...group] };
		}
		case "TOGGLE": {
			const t = action.text;
			const selected = state.selected.includes(t) ? state.selected.filter((x) => x !== t) : [...state.selected, t];
			return {
				...state,
				selected,
				merge: { ...state.merge, preview: null, error: null },
				generalize: { ...state.generalize, preview: null, error: null },
				subtract: { ...state.subtract, preview: null, error: null },
				generalized: null,
			};
		}
		case "subtractPreview":
			return { ...state, subtract: withPreview(state.subtract, action.ok, action.preview, action.error) };
		case "SUBTRACT_APPLYING":
			return { ...state, subtract: { ...state.subtract, applying: true } };
		case "subtracted":
			return { ...state, subtract: withApplied(state.subtract, action.error) };
		case "preview":
			if (action.mode === "collapse")
				return { ...state, merge: withPreview(state.merge, action.ok, action.text, action.error) };
			return {
				...state,
				generalize: withPreview(state.generalize, action.ok, action.text, action.error),
				generalized: action.ok && action.check ? { precision: action.precision ?? null, check: action.check } : null,
			};
		case "APPLYING":
			return action.mode === "collapse"
				? { ...state, merge: { ...state.merge, applying: true } }
				: { ...state, generalize: { ...state.generalize, applying: true } };
		case "applied":
			return action.mode === "collapse"
				? { ...state, merge: withApplied(state.merge, action.error) }
				: { ...state, generalize: withApplied(state.generalize, action.error) };
		case "SET_ASSIGNMENT": {
			const forOverload = { ...(state.assignments[action.overload] ?? {}) };
			if (action.value === "") delete forOverload[action.variable];
			else forOverload[action.variable] = action.value;
			const assignments = { ...state.assignments };
			if (Object.keys(forOverload).length === 0) delete assignments[action.overload];
			else assignments[action.overload] = forOverload;
			return { ...state, assignments, instantiate: { ...state.instantiate, error: null } };
		}
		// Every variable of the overload at once: those not in [values] are
		// cleared.
		case "SET_ASSIGNMENTS": {
			const assignments = { ...state.assignments, [action.overload]: action.values };
			if (Object.keys(action.values).length === 0) delete assignments[action.overload];
			return { ...state, assignments, instantiate: { ...state.instantiate, error: null } };
		}
		case "INST_APPLYING":
			return { ...state, instantiate: { ...state.instantiate, applying: true } };
		case "INST_CLEAR_PREVIEW":
			return { ...state, instantiate: { ...state.instantiate, preview: null } };
		case "instantiatePreview":
			return { ...state, instantiate: withPreview(state.instantiate, action.ok, action.overloads, action.error) };
		case "instantiated":
			return { ...state, instantiate: withApplied(state.instantiate, action.error) };
		default:
			// Every action above is handled, so [action] is [never] here. Adding an
			// action without a case makes this call a compile error pointing at the
			// gap. Unreachable at runtime while the types hold.
			return assertNever(action);
	}
}

function assertNever(action: never): never {
	throw new Error(`Unhandled action: ${JSON.stringify(action)}`);
}

function toAssignmentPairs(vars: Record<string, string>): Instantiation["assignments"] {
	return Object.entries(vars).map(([variable, type]) => ({ var: variable, type }));
}

// Build the instantiations payload from the assignment map, skipping overloads
// with no (non-empty) assignments.
function buildInstantiations(assignments: Assignments): Instantiation[] {
	return Object.entries(assignments)
		.map(([overload, vars]) => ({ overload, assignments: toAssignmentPairs(vars) }))
		.filter((i) => i.assignments.length > 0);
}

// Synchronous re-entrancy guard for the apply buttons. The [applying] flag only
// flips once the reducer has run, so two clicks in the same tick would both get
// through on it alone; the ref latches immediately. Returns a claim function:
// true when the caller took the slot, false when an apply is already in flight.
function useApplyGuard(applying: boolean): () => boolean {
	const inFlight = useRef(false);

	// Release the slot once the extension has replied.
	useEffect(() => {
		if (!applying) inFlight.current = false;
	}, [applying]);

	return () => {
		if (inFlight.current) return false;
		inFlight.current = true;
		return true;
	};
}

// The Apply / Replace / Insert triple. Both tools offer the same three scopes —
// keep the others, drop the others, or add alongside — so the row is one
// component and only the tooltips and handlers differ.
interface ActionRowProps {
	titles: { apply: string; replace: string; insert: string };
	onApply: () => void;
	onReplace: () => void;
	onInsert: () => void;
	disabled: boolean;
	// Swap Apply's label for "Applying…" while an edit is in flight. The
	// per-overload rows leave this off: one row of many changing its label reads
	// as noise when the whole card is already disabled.
	busy?: boolean;
	class?: string;
}

function ActionRow({ titles, onApply, onReplace, onInsert, disabled, busy, class: extraClass }: ActionRowProps) {
	return (
		<div class={extraClass ? `btn-row ${extraClass}` : "btn-row"}>
			<button class="btn btn-primary" type="button" title={titles.apply} disabled={disabled} onClick={onApply}>
				{busy ? "Applying…" : "Apply"}
			</button>
			<button class="btn btn-secondary" type="button" title={titles.replace} disabled={disabled} onClick={onReplace}>
				Replace
			</button>
			<button class="btn btn-secondary" type="button" title={titles.insert} disabled={disabled} onClick={onInsert}>
				Insert
			</button>
		</div>
	);
}

// How the generalized type compares with the overloads it was made from.
function PrecisionNote({ precision }: { precision: Precision }) {
	switch (precision) {
		case "stronger":
			return <p class="note precision-stronger">Stronger than the overloads</p>;
		case "equivalent":
			return <p class="note">Equivalent to the overloads</p>;
		case "weaker":
			return <p class="note precision-weaker">Weaker than the overloads</p>;
	}
}

const APPLY_TITLES: Record<MergeMode, { apply: string; replace: string; insert: string }> = {
	collapse: {
		apply: "Replace the selected overloads with the collapsed type; keep the rest",
		replace: "Replace ALL declarations with the collapsed type (drops the unselected overloads)",
		insert: "Add the collapsed type as a new declaration, keeping every existing one",
	},
	generalize: {
		apply: "Replace the selected overloads with the generalized type; keep the rest",
		replace: "Replace ALL declarations with the generalized type (drops the unselected overloads)",
		insert: "Add the generalized type as a new declaration, keeping every existing one",
	},
};

function MergeTool({ state, dispatch }: { state: AppState; dispatch: (a: Action) => void }) {
	const { merge, generalize, subtract } = state;
	// One apply at a time: all write the same declarations.
	const applying = merge.applying || generalize.applying || subtract.applying;
	const claimApply = useApplyGuard(applying);
	const g = state.generalized;
	const r = subtract.preview;
	// How many leading arguments make a case for domain subtraction: at most
	// as many as all the selected overloads take.
	const [depth, setDepth] = useState(1);
	const maxDepth = r?.maxDepth ?? 1;
	useEffect(() => {
		if (depth > maxDepth) setDepth(maxDepth);
	}, [depth, maxDepth]);

	// Request the previews whenever the selection changes and is non-empty.
	useEffect(() => {
		if (state.selected.length === 0 || !state.binding) return;
		for (const mode of ["collapse", "generalize"] as const)
			vscodeApi.postMessage({
				type: "requestPreview",
				name: state.binding.name,
				overloadTexts: state.selected,
				mode,
			});
	}, [state.selected, state.binding]);

	useEffect(() => {
		if (state.selected.length === 0 || !state.binding) return;
		vscodeApi.postMessage({
			type: "requestSubtract",
			name: state.binding.name,
			overloadTexts: state.selected,
			depth,
		});
	}, [state.selected, state.binding, depth]);

	function handleSubtract() {
		if (state.selected.length === 0 || !state.binding || !claimApply()) return;
		dispatch({ type: "SUBTRACT_APPLYING" });
		vscodeApi.postMessage({
			type: "applySubtract",
			name: state.binding.name,
			overloadTexts: state.selected,
			depth,
		});
	}

	// append=false,keepOthers=true → Apply (scoped: the result replaces the
	// selected, the rest kept); append=false,keepOthers=false → Replace (full:
	// the result only); append=true → Insert (the result appended, all existing
	// kept).
	function handleApply(mode: MergeMode, append: boolean, keepOthers: boolean) {
		if (state.selected.length === 0 || !state.binding || !claimApply()) return;
		dispatch({ type: "APPLYING", mode });
		vscodeApi.postMessage({
			type: "apply",
			name: state.binding.name,
			overloadTexts: state.selected,
			append,
			keepOthers,
			mode,
			overloads: state.overloads.map((o) => o.text),
		});
	}

	function actions(mode: MergeMode, tool: ToolState<string>) {
		return (
			<ActionRow
				titles={APPLY_TITLES[mode]}
				disabled={state.selected.length === 0 || applying || !tool.preview}
				busy={tool.applying}
				onApply={() => handleApply(mode, false, true)}
				onReplace={() => handleApply(mode, false, false)}
				onInsert={() => handleApply(mode, true, false)}
			/>
		);
	}

	// [precision]: generalize only, shown on the preview itself as a colored
	// edge and a caption, so it reads as a property of that type.
	function preview(tool: ToolState<string>, loading: string, precision?: Precision) {
		return tool.preview ? (
			<div class={`surface code-text preview-block${precision ? ` precision-edge-${precision}` : ""}`}>
				<Code text={tool.preview} />
				{precision && <PrecisionNote precision={precision} />}
			</div>
		) : (
			<div class="surface code-text preview-block preview-placeholder">
				{state.selected.length === 0 ? "Select overloads to see a preview." : loading}
			</div>
		);
	}

	return (
		<>
			<p class="note tool-subtitle">
				Combine the selected overloads into a single declared type, or make their domains disjoint.
			</p>
			{merge.stale && <p class="note stale-note">Types changed — selection updated.</p>}
			<div class="layout">
				<div>
					<p class="column-title">
						Overloads for <code>{state.binding?.name ?? ""}</code>
					</p>
					{state.overloads.length === 0 && <p class="note note-absent empty-note">No overloads available.</p>}
					{state.overloads.map(({ text }) => (
						<label
							key={text}
							class={`surface code-text overload-box${state.selected.includes(text) ? " selected" : ""}`}
						>
							<input
								type="checkbox"
								class="overload-checkbox"
								checked={state.selected.includes(text)}
								onChange={() => dispatch({ type: "TOGGLE", text })}
							/>
							<Code text={text} />
						</label>
					))}
				</div>
				<div class="merge-area">
					<div class="merge-result">
						<div class="result-head">
							<p
								class="result-title"
								title="The smallest single arrow containing the overloads. Always holds, but loses which input gives which output."
							>
								Collapse
							</p>
							{actions("collapse", merge)}
						</div>
						{merge.error && <p class="error-note">{merge.error}</p>}
						{preview(merge, "Loading preview…")}
					</div>
					<div class="merge-result">
						<div class="result-head">
							<p
								class="result-title"
								title="One polymorphic type whose instances are the overloads. Keeps which input gives which output, but may claim more than the definition gives, so it is checked against it."
							>
								Generalize
							</p>
							{actions("generalize", generalize)}
						</div>
						{generalize.error && <p class="error-note">{generalize.error}</p>}
						{preview(generalize, "Generalizing and checking…", g?.precision ?? undefined)}
						{g && !g.check.ok && (
							<div class="generalize-status">
								<p class="error-note">Does not type check.</p>
								{g.check.errors.map((e) => (
									<p key={e} class="surface code-text preview-lines">
										{e}
									</p>
								))}
							</div>
						)}
					</div>
					<div class="merge-result">
						<div class="result-head">
							<p
								class="result-title"
								title="Make the cases disjoint as first-match pattern matching does: each case minus those of the overloads before it. A case is the first arguments, as many as picked; a case strictly inside another goes first, otherwise the order of the val lines. A case can split into several val lines."
							>
								Domain subtraction
							</p>
							{maxDepth > 1 && (
								<fieldset class="subtract-depth">
									<legend>Arguments</legend>
									{Array.from({ length: maxDepth }, (_, i) => i + 1).map((d) => (
										<button
											key={d}
											type="button"
											class={`subtract-depth-btn${d === depth ? " active" : ""}`}
											aria-pressed={d === depth}
											title={d === 1 ? "Cases are the first argument" : `Cases are the first ${d} arguments`}
											onClick={() => setDepth(d)}
										>
											{d}
										</button>
									))}
								</fieldset>
							)}
							<button
								class="btn btn-primary"
								type="button"
								title="Rewrite the domains of the val lines"
								disabled={state.selected.length === 0 || applying || !r || r.changed === 0}
								onClick={handleSubtract}
							>
								Apply
							</button>
						</div>
						{subtract.error && <p class="error-note">{subtract.error}</p>}
						{r ? (
							<>
								<div class="surface code-text preview-block preview-lines">
									{/* A line that splits holds its new lines. Keyed by
									    position: lines are in file order. */}
									{r.lines
										.flatMap((line) => line.split("\n").map((l) => l.trimStart()))
										.map((line, i) => (
											<div key={i}>
												<Code text={line} />
											</div>
										))}
								</div>
								{r.changed === 0 && <p class="note">The selected domains do not overlap.</p>}
								{r.unreachable.length > 0 && (
									<p class="note stale-note">Covered by the others, so unreachable: {r.unreachable.join("; ")}</p>
								)}
							</>
						) : (
							!subtract.error && (
								<div class="surface code-text preview-block preview-placeholder">
									{state.selected.length === 0 ? "Select overloads to see a preview." : "Loading preview…"}
								</div>
							)
						)}
					</div>
				</div>
			</div>
		</>
	);
}

// The instances of an overload that its calls use. Clicking one fills in the
// overload's variables with it, and clicking it again clears them; the one
// the fields hold is marked. The tooltip lists its calls.
function CallInstances({
	overload,
	instances,
	assigned,
	dispatch,
}: {
	overload: string;
	instances: CallInstance[];
	assigned: Record<string, string>;
	dispatch: (a: Action) => void;
}) {
	if (instances.length === 0) return null;
	return (
		<div class="call-instances">
			<span class="call-instances-label">From calls</span>
			{instances.map((inst) => {
				const values = Object.fromEntries(inst.assignments.map((a) => [a.var, a.type]));
				const key = inst.assignments.map((a) => `${a.var}=${a.type}`).join(",");
				const active =
					Object.keys(assigned).length === inst.assignments.length &&
					inst.assignments.every((a) => assigned[a.var] === a.type);
				return (
					<button
						key={key}
						type="button"
						class={`call-instance${active ? " active" : ""}`}
						aria-pressed={active}
						title={inst.calls.map((c) => `line ${c.line + 1}: ${c.text}`).join("\n")}
						onClick={() => dispatch({ type: "SET_ASSIGNMENTS", overload, values: active ? {} : values })}
					>
						<Code text={inst.assignments.map((a) => `${a.var} = ${a.type}`).join(", ")} />
						{inst.calls.length > 1 && <span class="call-count">×{inst.calls.length}</span>}
					</button>
				);
			})}
		</div>
	);
}

function InstantiateTool({ state, dispatch }: { state: AppState; dispatch: (a: Action) => void }) {
	const inst = state.instantiate;
	const claimApply = useApplyGuard(inst.applying);
	const assignedTexts = buildInstantiations(state.assignments).map((i) => i.overload);
	const hasAssignments = assignedTexts.length > 0;

	// Debounced preview request whenever assignments change. When nothing is
	// assigned, clear any stale preview instead of requesting one.
	useEffect(() => {
		if (!state.binding) return;
		const instantiations = buildInstantiations(state.assignments);
		if (instantiations.length === 0) {
			dispatch({ type: "INST_CLEAR_PREVIEW" });
			return;
		}
		const name = state.binding.name;
		const timer = setTimeout(() => {
			vscodeApi.postMessage({ type: "requestInstantiatePreview", name, instantiations });
		}, 150);
		return () => clearTimeout(timer);
	}, [state.assignments, state.binding, dispatch]);

	// Write [instantiations]. [only] selects which result overloads survive:
	//  Apply (scoped) → only=undefined (the unassigned overloads are kept too);
	//  Replace (full) → only=<the instantiated texts> (drop everything else);
	//  Insert → append, same [only] as Replace.
	// Overloads with nothing assigned are dropped, so an empty payload is a no-op.
	function postApply(instantiations: Instantiation[], append: boolean, only?: string[]) {
		const payload = instantiations.filter((i) => i.assignments.length > 0);
		if (payload.length === 0 || !state.binding || !claimApply()) return;
		dispatch({ type: "INST_APPLYING" });
		vscodeApi.postMessage({
			type: "applyInstantiate",
			name: state.binding.name,
			instantiations: payload,
			append,
			only,
		});
	}

	// Every assigned overload at once.
	function handleApply(append: boolean, only?: string[]) {
		postApply(buildInstantiations(state.assignments), append, only);
	}

	// Just this row's overload, with the same [only] semantics as above.
	function handleRowApply(text: string, assigned: Record<string, string>, append: boolean, only?: string[]) {
		postApply([{ overload: text, assignments: toAssignmentPairs(assigned) }], append, only);
	}

	return (
		<>
			<p class="note tool-subtitle">
				Pin a type variable to a concrete type, per overload. Variables are independent across overloads. Under an
				overload, the instances its calls in this file use.
			</p>
			{inst.error && <p class="error-note">{inst.error}</p>}
			{inst.stale && <p class="note stale-note">Types changed — assignments updated.</p>}
			<div class="inst-list">
				{state.overloads.length === 0 && <p class="note note-absent empty-note">No overloads available.</p>}
				{state.overloads.map(({ text, vars, instances }) => {
					const assigned = state.assignments[text] ?? {};
					const rowAssigned = Object.keys(assigned).length > 0;
					return (
						<div key={text} class="surface inst-overload">
							<div class="inst-overload-main">
								<div class="code-text inst-overload-text">
									<Code text={text} />
								</div>
								{vars.length === 0 ? (
									<p class="note note-absent empty-note">No type variables.</p>
								) : (
									<div class="var-row">
										{vars.map((v) => (
											<span key={v} class="var-field">
												<span class="var-name">{v}</span>
												<span class="var-input-wrap">
													<TypeSelect
														options={state.concreteTypes}
														value={assigned[v] ?? ""}
														onChange={(value) =>
															dispatch({ type: "SET_ASSIGNMENT", overload: text, variable: v, value })
														}
														label={`Type for ${v}`}
														placeholder="type…"
														changed={assigned[v] !== undefined}
														free
													/>
													{assigned[v] ? (
														<button
															type="button"
															class="var-clear"
															title="Clear"
															aria-label={`Clear ${v}`}
															onClick={() =>
																dispatch({ type: "SET_ASSIGNMENT", overload: text, variable: v, value: "" })
															}
														>
															×
														</button>
													) : null}
												</span>
											</span>
										))}
									</div>
								)}
								<CallInstances overload={text} instances={instances} assigned={assigned} dispatch={dispatch} />
							</div>
							{vars.length > 0 && (
								<ActionRow
									class="inst-row-btns"
									titles={{
										apply: "Replace the declarations, instantiating only this overload; keep the others",
										replace: "Replace ALL declarations with only this instantiated overload (drops the others)",
										insert: "Add this overload's instantiated type as a new declaration, keeping every existing one",
									}}
									disabled={!rowAssigned || inst.applying}
									onApply={() => handleRowApply(text, assigned, false, undefined)}
									onReplace={() => handleRowApply(text, assigned, false, [text])}
									onInsert={() => handleRowApply(text, assigned, true, [text])}
								/>
							)}
						</div>
					);
				})}
			</div>
			<div class="inst-footer">
				<div>
					{inst.preview && inst.preview.length > 0 ? (
						<div class="surface code-text preview-block preview-lines">
							{/* Keyed by position: two overloads can instantiate to the same
							    signature, so the text is not a unique identity here. */}
							{inst.preview.map((line, i) => (
								<div key={i}>
									<Code text={line} />
								</div>
							))}
						</div>
					) : (
						<div class="surface code-text preview-block preview-placeholder">
							{hasAssignments ? "Loading preview…" : "Assign a type variable to see a preview."}
						</div>
					)}
				</div>
				<ActionRow
					titles={{
						apply: "Replace the declarations, instantiating the assigned overloads; keep the others",
						replace: "Replace ALL declarations with only the instantiated overloads (drops the rest)",
						insert: "Add the instantiated overloads as new declarations, keeping every existing one",
					}}
					disabled={!hasAssignments || inst.applying}
					busy={inst.applying}
					onApply={() => handleApply(false, undefined)}
					onReplace={() => handleApply(false, assignedTexts)}
					onInsert={() => handleApply(true, assignedTexts)}
				/>
			</div>
		</>
	);
}

// Identifies a hole across refreshes: its line, row of values and start
// character.
function holeKey(line: number, row: number, start: number) {
	return `${line}:${row}:${start}`;
}

// A val line with its holes marked: as written ([row] undefined), or with
// the values of a row in their place. A hole is a toggle, selected holes
// being the ones Fill writes: in a row, or as written when the line has a
// single row. A hole a row has no value for stays as written.
function HoleText({
	line,
	row,
	selected,
	dispatch,
}: {
	line: HoleLine;
	row?: number;
	selected: string[];
	dispatch: (a: Action) => void;
}) {
	const toggles = row ?? (line.rows.length === 1 ? 0 : undefined);
	const parts: ComponentChildren[] = [];
	let at = 0;
	// The text around holes ends at a hole, so highlighting it piece by piece
	// splits no token.
	line.holes.forEach((h, i) => {
		parts.push(<Code key={`t${at}`} text={line.text.slice(at, h.start)} />);
		const written = line.text.slice(h.start, h.end);
		const value = row === undefined ? null : line.rows[row].values[i];
		if (toggles === undefined || (row !== undefined && value === null)) {
			parts.push(
				<span
					key={h.start}
					class={row === undefined ? "hole" : "hole hole-none"}
					title={row === undefined ? undefined : "No value for this overload"}
				>
					<Code text={written} />
				</span>,
			);
		} else {
			const on = selected.includes(holeKey(line.line, toggles, h.start));
			const shown = line.rows[toggles].values[i];
			parts.push(
				<button
					key={h.start}
					type="button"
					class={`hole${row !== undefined ? " hole-filled" : ""}${on ? " hole-selected" : ""}`}
					aria-pressed={on}
					title={`${h.hole} = ${shown}`}
					onClick={() => dispatch({ type: "TOGGLE_HOLE", line: line.line, row: toggles, start: h.start })}
				>
					<Code text={row === undefined ? written : (value ?? written)} />
				</button>,
			);
		}
		at = h.end;
	});
	parts.push(<Code key={`t${at}`} text={line.text.slice(at)} />);
	return <>{parts}</>;
}

let typeSelectCount = 0;

// A dropdown of types: a button showing [value] (or [children], when given)
// that opens the list of [options] under it. The keyboard works as in a
// listbox: arrows move, Enter or Space picks, Escape closes; a click outside,
// a scroll or a resize closes too. The list is placed on the page, not in
// the button's box, so a scrolling container does not cut it. With [free],
// the list starts with a field where any type can be typed. [notes] are
// shown dimmed after the options they are for.
function TypeSelect({
	options,
	notes,
	value,
	onChange,
	label,
	placeholder,
	changed,
	free,
	buttonClass,
	buttonStyle,
	children,
}: {
	options: string[];
	notes?: Record<string, string>;
	value: string;
	onChange: (v: string) => void;
	label: string;
	placeholder?: string;
	changed?: boolean;
	free?: boolean;
	buttonClass?: string;
	buttonStyle?: Record<string, string>;
	children?: ComponentChildren;
}) {
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const [typed, setTyped] = useState("");
	const [pos, setPos] = useState({ top: 0, left: 0 });
	const id = useRef(`type-select-${++typeSelectCount}`).current;
	const root = useRef<HTMLSpanElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const field = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open) return;
		(free ? field.current : list.current)?.focus();
		const outside = (e: MouseEvent) => {
			if (!root.current?.contains(e.target as Node)) setOpen(false);
		};
		const close = (e: Event) => {
			if (!list.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", outside);
		window.addEventListener("scroll", close, true);
		window.addEventListener("resize", close);
		return () => {
			document.removeEventListener("mousedown", outside);
			window.removeEventListener("scroll", close, true);
			window.removeEventListener("resize", close);
		};
	}, [open, free]);

	function show() {
		const r = button.current?.getBoundingClientRect();
		if (r) setPos({ top: r.bottom + 2, left: r.left });
		setActive(Math.max(0, options.indexOf(value)));
		setTyped("");
		setOpen(true);
	}

	function pick(v: string) {
		onChange(v);
		setOpen(false);
		button.current?.focus();
	}

	function onKey(e: KeyboardEvent) {
		const last = options.length - 1;
		if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, last));
		else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
		else if (e.key === "Enter" && typed.trim() !== "") pick(typed.trim());
		else if ((e.key === "Enter" || (e.key === " " && !free)) && options[active] !== undefined) pick(options[active]);
		else if (e.key === "Escape" || e.key === "Tab") {
			setOpen(false);
			if (e.key === "Escape") button.current?.focus();
			return;
		} else return;
		e.preventDefault();
	}

	return (
		<span class="type-select" ref={root}>
			<button
				ref={button}
				type="button"
				class={buttonClass ?? `type-select-button${changed ? " changed" : ""}`}
				style={buttonStyle}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={label}
				title={label}
				onClick={() => (open ? setOpen(false) : show())}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						show();
					}
				}}
			>
				{children ?? (
					<>
						{value === "" ? <span class="type-select-placeholder">{placeholder}</span> : <Code text={value} />}
						<svg class="type-select-chevron" viewBox="0 0 16 16" aria-hidden="true">
							<path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.2" />
						</svg>
					</>
				)}
			</button>
			{open && (
				<div
					ref={list}
					class="type-select-menu"
					style={{ top: `${pos.top}px`, left: `${pos.left}px` }}
					role="listbox"
					tabIndex={-1}
					aria-label={label}
					aria-activedescendant={`${id}-${active}`}
					onKeyDown={onKey}
				>
					{free && (
						<input
							ref={field}
							class="type-select-field"
							type="text"
							placeholder="any type…"
							aria-label={`${label}: any type`}
							value={typed}
							onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
						/>
					)}
					{options.map((o, i) => (
						// The list has the focus and points at the active option,
						// so options are not tab stops.
						<div
							key={o}
							id={`${id}-${i}`}
							role="option"
							tabIndex={-1}
							aria-selected={o === value}
							class={`type-select-option${i === active ? " active" : ""}${o === value ? " selected" : ""}`}
							onMouseEnter={() => setActive(i)}
							onMouseDown={(e) => {
								// Keep the focus in the list until the pick moves it.
								e.preventDefault();
								pick(o);
							}}
						>
							<Code text={o} />
							{notes?.[o] && <span class="type-select-note">{notes[o]}</span>}
						</div>
					))}
				</div>
			)}
		</span>
	);
}

function partKey(line: number, p: TypePart) {
	return `${line}:${p.start}:${p.end}`;
}

// The height of each part of a line among its parts: 0 when none is inside
// it, else one more than the highest inside. Parts of one height do not
// nest, so they share a track.
function partHeights(parts: TypePart[]): number[] {
	const inside = (a: TypePart, b: TypePart) =>
		a !== b && b.start <= a.start && a.end <= b.end && (a.start !== b.start || a.end !== b.end);
	const heights = new Map<TypePart, number>();
	const height = (p: TypePart): number => {
		const known = heights.get(p);
		if (known !== undefined) return known;
		const h = parts.reduce((m, q) => (inside(q, p) ? Math.max(m, height(q) + 1) : m), 0);
		heights.set(p, h);
		return h;
	};
	return parts.map(height);
}

// A val line: its text, the chosen parts tinted, and under it the anchors
// of the parts a tool has options for, innermost nearest the text. An
// anchor opens its part's options ([what] says what they are). Under the
// block, the line with the choices written.
function PartLineView({
	line,
	what,
	chosen,
	choose,
}: {
	line: PartLine;
	what: string;
	chosen: Record<string, string>;
	choose: (p: TypePart, v: string) => void;
}) {
	const heights = partHeights(line.parts);
	const tracks = Math.max(-1, ...heights) + 1;
	const cols = `${line.text.length}ch`;
	const choice = (p: TypePart) => chosen[partKey(line.line, p)];
	// The colour of a chosen part, by its order on the line.
	const color = (i: number) => partColor(i);
	// The text, a chosen part tinted.
	const pieces: ComponentChildren[] = [];
	const picked = line.parts
		.map((p, i) => ({ p, i }))
		.filter(({ p }) => choice(p) !== undefined)
		.sort((a, b) => a.p.start - b.p.start);
	let at = 0;
	for (const { p, i } of picked) {
		pieces.push(<Code key={`t${at}`} text={line.text.slice(at, p.start)} />);
		pieces.push(
			<span key={`p${p.start}`} style={{ background: `color-mix(in srgb, ${color(i)} 30%, transparent)` }}>
				<Code text={line.text.slice(p.start, p.end)} />
			</span>,
		);
		at = p.end;
	}
	pieces.push(<Code key={`t${at}`} text={line.text.slice(at)} />);
	// The line with the choices written, from the last part back so that
	// the columns of the others stay right.
	const written = picked.reduceRight(
		(text, { p }) => text.slice(0, p.start) + choice(p) + text.slice(p.end),
		line.text,
	);
	return (
		<div class="extract-line">
			<div class="surface code-text extract-block">
				<div class="extract-text">{pieces}</div>
				{Array.from({ length: tracks }, (_, h) => (
					// Keyed by height: tracks are the levels of nesting.
					<div key={h} class="widen-track" style={{ width: cols }}>
						{line.parts.map((p, i) => {
							if (heights[i] !== h) return null;
							const v = choice(p);
							return (
								<TypeSelect
									key={partKey(line.line, p)}
									options={[p.text, ...p.options.map((o) => o.text)]}
									notes={Object.fromEntries(p.options.flatMap((o) => (o.label ? [[o.text, o.label]] : [])))}
									value={v ?? p.text}
									onChange={(nv) => choose(p, nv)}
									label={`${what} for ${p.text}`}
									buttonClass={`widen-anchor${v !== undefined ? " chosen" : ""}`}
									buttonStyle={{ left: `${p.start}ch`, width: `${p.end - p.start}ch` }}
								>
									<span
										class="anchor"
										// Inset by a few pixels, so that the slanted ends of
										// neighbouring parts do not touch.
										style={{ left: "3px", right: "3px", color: v !== undefined ? color(i) : undefined }}
									/>
								</TypeSelect>
							);
						})}
					</div>
				))}
			</div>
			{picked.length > 0 && (
				<div class="surface code-text preview-block widen-written">
					<Code text={written} />
				</div>
			)}
		</div>
	);
}

// What each part tool offers, for its subtitle and labels.
const PART_TOOLS: Record<PartTool, { what: string; subtitle: string }> = {
	widen: {
		what: "Wider type",
		subtitle: "Click under a part of a val type to pick a wider type for it, innermost parts nearest the text.",
	},
	simplify: {
		what: "Simplified form",
		subtitle:
			"Click under a part of a val type to pick a simplified form of it, each with the steps that give it. Every form means the same.",
	},
};

// The val lines of the target with an anchor under each part [tool] has
// options for. Picking an option for a part leaves out the choices of the
// parts nested in it or around it. Apply writes every choice.
function PartsTool({ tool, state, dispatch }: { tool: PartTool; state: AppState; dispatch: (a: Action) => void }) {
	const { lines, applying, error } = state.parts[tool];
	const claimApply = useApplyGuard(applying);
	const [chosen, setChosen] = useState<Record<string, string>>({});
	// Choices are for the lines as they were: new lines start without any.
	const linesKey = lines.map((l) => `${l.line}:${l.text}`).join("\n");
	useEffect(() => setChosen({}), [linesKey]);
	const choose = (line: PartLine) => (p: TypePart, v: string) =>
		setChosen((c) => {
			const next: Record<string, string> = {};
			for (const q of line.parts) {
				const k = partKey(line.line, q);
				const overlaps = q.start < p.end && p.start < q.end;
				if (!overlaps && c[k] !== undefined) next[k] = c[k];
			}
			for (const [k, cv] of Object.entries(c)) if (!k.startsWith(`${line.line}:`)) next[k] = cv;
			if (v !== p.text) next[partKey(line.line, p)] = v;
			return next;
		});
	const edits = lines.flatMap((l) =>
		l.parts.flatMap((p) => {
			const v = chosen[partKey(l.line, p)];
			return v === undefined ? [] : [{ line: l.line, start: p.start, end: p.end, part: p.text, text: v }];
		}),
	);
	const apply = () => {
		if (edits.length === 0 || !claimApply()) return;
		dispatch({ type: "PARTS_APPLYING", tool });
		vscodeApi.postMessage({ type: "applyParts", tool, edits });
	};
	const { what, subtitle } = PART_TOOLS[tool];
	return (
		<>
			<p class="note tool-subtitle">{subtitle}</p>
			{error && <p class="error-note">{error}</p>}
			{lines.map((l) => (
				<PartLineView key={l.line} line={l} what={what} chosen={chosen} choose={choose(l)} />
			))}
			<div class="btn-row">
				<button
					class="btn btn-primary"
					type="button"
					title={edits.length > 0 ? "Write the picked types" : "Pick a type for a part first"}
					disabled={edits.length === 0 || applying}
					onClick={apply}
				>
					Apply
				</button>
			</div>
		</>
	);
}

// The draft val lines of the target: each as written, then filled in, once,
// or once per overload of its result when they disagree on its holes. Fill
// writes a row's selected holes, and is disabled until one is selected; Fill
// all writes every hole of the lines with a single row.
function HolesTool({ state, dispatch }: { state: AppState; dispatch: (a: Action) => void }) {
	const fill = (holes?: { line: number; row: number; start: number }[]) =>
		vscodeApi.postMessage({ type: "fillHoles", holes });
	const several = state.holes.some((l) => l.rows.length > 1);
	return (
		<>
			<p class="note tool-subtitle">
				The types the holes of the draft signature were resolved to. Click holes to fill only those.
			</p>
			{state.holes.map((l) => (
				<div key={l.line} class="hole-line">
					<div class="surface code-text preview-block">
						<HoleText line={l} selected={state.selectedHoles} dispatch={dispatch} />
					</div>
					{l.rows.map((_, row) => {
						const picked = l.holes
							.filter((h) => state.selectedHoles.includes(holeKey(l.line, row, h.start)))
							.map((h) => ({ line: l.line, row, start: h.start }));
						// Keyed by position: rows are the overloads, in order.
						return (
							<div key={row} class="hole-row">
								<div class="hole-filled-row">
									<div class="surface code-text preview-block">
										<HoleText line={l} row={row} selected={state.selectedHoles} dispatch={dispatch} />
									</div>
									<button
										class="btn btn-secondary"
										type="button"
										title={
											picked.length > 0
												? "Write the selected holes of this row"
												: "Select holes of this row to fill them"
										}
										disabled={picked.length === 0}
										onClick={() => fill(picked)}
									>
										Fill
									</button>
								</div>
							</div>
						);
					})}
				</div>
			))}
			<div class="btn-row">
				<button
					class="btn btn-primary"
					type="button"
					title={
						several
							? "Write every hole of the lines with one value per hole; a line with several overloads is filled from its rows"
							: "Write every hole of the signature"
					}
					onClick={() => fill()}
				>
					Fill all
				</button>
			</div>
		</>
	);
}

// The colours of the parts, as of the overload rows of hovers.
const PART_COLORS = ["#e5534b", "#539bf5", "#c69026", "#57ab5a", "#986ee2", "#cc6b2c"];

function partColor(i: number) {
	return PART_COLORS[i % PART_COLORS.length];
}

// The text of a val line, the occurrences of the chosen parts tinted in
// their colour (the innermost one where they nest), and those of the part
// under the mouse outlined.
function ExtractText({ line, chosen, hovered }: { line: ExtractLine; chosen: string[]; hovered: string | null }) {
	const n = line.text.length;
	const tint: (number | null)[] = Array(n).fill(null);
	const width: number[] = Array(n).fill(Number.POSITIVE_INFINITY);
	const outline: boolean[] = Array(n).fill(false);
	line.groups.forEach((g, gi) => {
		for (const [a, b] of g.occurrences) {
			for (let i = a; i < b; i++) {
				if (chosen.includes(g.key) && b - a < width[i]) {
					tint[i] = gi;
					width[i] = b - a;
				}
				if (g.key === hovered) outline[i] = true;
			}
		}
	});
	const parts: ComponentChildren[] = [];
	let start = 0;
	for (let i = 1; i <= n; i++) {
		if (i < n && tint[i] === tint[start] && outline[i] === outline[start]) continue;
		const t = tint[start];
		const style = t === null ? undefined : { background: `color-mix(in srgb, ${partColor(t)} 30%, transparent)` };
		parts.push(
			// Runs start and end at parts, which are whole tokens.
			<span key={start} class={outline[start] ? "part-hovered" : undefined} style={style}>
				<Code text={line.text.slice(start, i)} />
			</span>,
		);
		start = i;
	}
	return <div class="extract-text">{parts}</div>;
}

// One val line: its text, and under it a row per repeated part, largest
// first, with an anchor under each occurrence in the part's colour. A row
// toggles its part; a chosen part can be renamed.
function ExtractLineView({
	line,
	index,
	state,
	dispatch,
}: {
	line: ExtractLine;
	index: number;
	state: AppState;
	dispatch: (a: Action) => void;
}) {
	const ex = state.extract;
	const chosen = ex.chosen[index] ?? [];
	const [hovered, setHovered] = useState<string | null>(null);
	const cols = `${line.text.length}ch`;
	return (
		<div class="extract-line">
			<div class="surface code-text extract-block">
				<ExtractText line={line} chosen={chosen} hovered={hovered} />
				{/* Smallest part first, so that a part inside another is
				    underlined closer to the text. */}
				{line.groups
					.map((g, gi) => ({ g, gi }))
					.reverse()
					.map(({ g, gi }) => {
						const on = chosen.includes(g.key);
						const toggle = () => dispatch({ type: "TOGGLE_EXTRACT", line: index, key: g.key });
						return (
							<div key={g.key} class={on ? "anchor-row chosen" : "anchor-row"}>
								<button
									type="button"
									class="anchor-track"
									style={{ width: cols }}
									aria-pressed={on}
									title={`${on ? "Click to leave out" : "Click to extract"}: ${g.key}${g.holes > 0 ? " (has holes)" : ""}${g.global ? " (as a top-level type)" : ""}`}
									onClick={toggle}
									onMouseEnter={() => setHovered(g.key)}
									onMouseLeave={() => setHovered(null)}
									onFocus={() => setHovered(g.key)}
									onBlur={() => setHovered(null)}
								>
									{g.occurrences.map(([a, b]) => (
										<span
											key={a}
											class="anchor"
											// Inset by a few pixels, so that the slanted ends of
											// neighbouring occurrences do not touch. Coloured only
											// when the part is chosen.
											style={{
												left: `calc(${a}ch + 3px)`,
												width: `calc(${b - a}ch - 6px)`,
												color: on ? partColor(gi) : undefined,
											}}
										/>
									))}
								</button>
								<input
									class="anchor-name"
									type="text"
									aria-label={`Name for ${g.key}`}
									disabled={!on}
									value={ex.names[extractKey(index, g.key)] ?? g.name}
									onInput={(e) =>
										dispatch({
											type: "SET_EXTRACT_NAME",
											line: index,
											key: g.key,
											name: (e.target as HTMLInputElement).value,
										})
									}
								/>
							</div>
						);
					})}
			</div>
		</div>
	);
}

// The chosen parts of a line, as the server takes them.
function extractChoices(ex: ExtractState, line: number): ExtractChoice[] {
	return (ex.chosen[line] ?? []).map((key) => ({ key, name: ex.names[extractKey(line, key)] ?? "" }));
}

// Lines with chosen parts, and the modes worth previewing for each: the
// parameter mode only differs when a chosen part has holes.
function extractModes(ex: ExtractState): { line: number; modes: ExtractMode[] }[] {
	return ex.lines.flatMap((l, i) => {
		const chosen = ex.chosen[i] ?? [];
		if (chosen.length === 0) return [];
		const holes = l.groups.some((g) => chosen.includes(g.key) && g.holes > 0);
		return [{ line: i, modes: holes ? (["plain", "params"] as ExtractMode[]) : (["plain"] as ExtractMode[]) }];
	});
}

const MODE_TITLES: Record<ExtractMode, { title: string; hint: string; button: string }> = {
	plain: {
		title: "Shared holes",
		hint: "Extract the parts as they are: all copies of a part with holes share them.",
		button: "Extract",
	},
	params: {
		title: "Separate holes",
		hint: "Extract each hole as a parameter: every copy keeps its own holes, and the type its meaning.",
		button: "Extract",
	},
};

function ExtractTool({ state, dispatch }: { state: AppState; dispatch: (a: Action) => void }) {
	const ex = state.extract;
	// Previews follow the choices and names, debounced while typing a name.
	const request = JSON.stringify(extractModes(ex).map(({ line, modes }) => [line, modes, extractChoices(ex, line)]));
	useEffect(() => {
		const timer = setTimeout(() => {
			for (const { line, modes } of extractModes(ex)) {
				for (const mode of modes) {
					vscodeApi.postMessage({ type: "requestExtractPreview", line, mode, groups: extractChoices(ex, line) });
				}
			}
		}, 250);
		return () => clearTimeout(timer);
	}, [request]);
	const apply = (line: number, mode: ExtractMode) => {
		if (ex.applying) return;
		dispatch({ type: "EXTRACT_APPLYING" });
		vscodeApi.postMessage({ type: "applyExtract", line, mode, groups: extractChoices(ex, line) });
	};
	return (
		<>
			<p class="note tool-subtitle">Extract repeated parts of the signature into where definitions.</p>
			{ex.error && <p class="error-note">{ex.error}</p>}
			{ex.lines.map((l, i) => {
				if (l.groups.length === 0) return null;
				const modes = extractModes(ex).find((m) => m.line === i)?.modes ?? [];
				return (
					<div key={l.text} class="extract-group">
						<ExtractLineView line={l} index={i} state={state} dispatch={dispatch} />
						{modes.map((mode) => {
							const p = ex.previews[`${i}:${mode}`];
							const t = MODE_TITLES[mode];
							return (
								<div key={mode} class="merge-result">
									<div class="result-head">
										<p class="result-title" title={t.hint}>
											{modes.length > 1 ? t.title : "Result"}
										</p>
										<button
											class="btn btn-primary"
											type="button"
											disabled={ex.applying || !p?.ok}
											onClick={() => apply(i, mode)}
										>
											{ex.applying ? "Extracting…" : t.button}
										</button>
									</div>
									{p && !p.ok && <p class="error-note">{p.error}</p>}
									<div class="surface code-text preview-block">
										{p?.ok &&
											p.decls?.map((d) => (
												<div key={d} class="extract-decl">
													<Code text={d} />
												</div>
											))}
										{p?.ok && p.text !== undefined ? <Code text={p.text} /> : "Loading preview…"}
										{p?.linksHoles && <p class="note precision-stronger">The copies of a part share its holes.</p>}
									</div>
								</div>
							);
						})}
					</div>
				);
			})}
		</>
	);
}

// A collapsible section in the style of VS Code's view panes: a full-width
// header with a chevron and an uppercase title, and the body below it.
// A tool with nothing to work on for the target ([unavailable], why) stays
// listed, collapsed, with the reason in its header.
function Section({
	id,
	title,
	state,
	dispatch,
	unavailable,
	children,
}: {
	id: SectionId;
	title: string;
	state: AppState;
	dispatch: (a: Action) => void;
	unavailable?: string;
	children: ComponentChildren;
}) {
	const expanded = !unavailable && !state.collapsed[id];
	return (
		<section class={expanded ? "pane expanded" : "pane"}>
			<h2 class="pane-header">
				<button
					type="button"
					class="pane-toggle"
					aria-expanded={expanded}
					aria-controls={`pane-${id}`}
					disabled={unavailable !== undefined}
					onClick={() => dispatch({ type: "TOGGLE_SECTION", id })}
				>
					{/* No chevron when the tool cannot open: only the space it takes. */}
					<svg class="pane-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
						{!unavailable && <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.2" />}
					</svg>
					{title}
					{unavailable && <span class="pane-unavailable">{unavailable}</span>}
				</button>
			</h2>
			{expanded && (
				<div class="pane-body" id={`pane-${id}`}>
					{children}
				</div>
			)}
		</section>
	);
}

// Every answer of the run so far, collapsed: what it proposed and what came
// of it, with the errors sent back to the LLM collapsed under it.
function AttemptsList({ attempts }: { attempts: LlmAttempt[] }) {
	if (attempts.length === 0) return null;
	return (
		<details class="attempts">
			<summary>{attempts.length === 1 ? "The 1 try" : `All ${attempts.length} tries`}</summary>
			<ol class="attempt-list">
				{attempts.map((a, i) => (
					<li key={i} class="attempt">
						<div class="attempt-head">
							<span class="attempt-n">Try {i + 1}</span>
							<span class={`attempt-result result-${a.result.replace(/ /g, "-")}`}>{a.result}</span>
						</div>
						{a.vals.length > 0 ? (
							<div class="surface code-text preview-lines attempt-vals">
								{a.vals.map((v, j) => (
									<div key={j}>
										<Code text={v} />
									</div>
								))}
							</div>
						) : null}
						{a.errors && a.errors.length > 0 && (
							<details class="attempt-errors">
								<summary>{a.errors.length === 1 ? "1 error" : `${a.errors.length} errors`}</summary>
								<ul>
									{a.errors.map((e, j) => (
										<li key={j} class="code-text">
											{e}
										</li>
									))}
								</ul>
							</details>
						)}
					</li>
				))}
			</ol>
		</details>
	);
}

function LlmStatusView({ status }: { status: LlmStatus }) {
	switch (status.state) {
		case "idle":
			return null;
		case "running":
			return (
				<div class="llm-result">
					<p class="note llm-status" aria-live="polite">
						Inferring the type of <code>{status.name}</code>: try {status.tries} of {status.maxTries}…
					</p>
					{/* Restored from an older version, a status may lack attempts. */}
					<AttemptsList attempts={status.attempts ?? []} />
				</div>
			);
		case "done":
			return (
				<div class="llm-result" aria-live="polite">
					{status.ok ? (
						<p class="llm-ok">
							Found a type of <code>{status.name}</code> that checks after <strong>{triesText(status.tries)}</strong>.
						</p>
					) : (
						<p class="error-note">{status.message}</p>
					)}
					{status.vals && status.vals.length > 0 && (
						<div class="surface code-text preview-block preview-lines">
							{status.vals.map((v, i) => (
								<div key={i}>
									<Code text={v} />
								</div>
							))}
						</div>
					)}
					<AttemptsList attempts={status.attempts ?? []} />
				</div>
			);
	}
}

function LlmTool({ state }: { state: AppState }) {
	const settings = state.llmSettings;
	const running = state.llmStatus.state === "running";
	const name = state.target;
	return (
		<>
			{settings && settings.models.length > 0 && (
				<label class="llm-model">
					<span>Model</span>
					{/* Options are keyed by their index in settings.models, grouped by
					    provider (and API) since two providers may offer the same
					    model, and one model may come at several efforts. */}
					<select
						class="select"
						value={String(
							settings.models.findIndex((m) => settings.model !== undefined && sameModel(m, settings.model)),
						)}
						disabled={running}
						onChange={(e) => {
							const model = settings.models[Number((e.target as HTMLSelectElement).value)];
							if (model) vscodeApi.postMessage({ type: "selectModel", model });
						}}
					>
						{[...new Set(settings.models.map((m) => `${m.api}:${m.provider}`))].map((group) => (
							<optgroup key={group} label={group.slice(group.indexOf(":") + 1)}>
								{settings.models.map((m, i) =>
									`${m.api}:${m.provider}` === group ? (
										<option key={i} value={String(i)}>
											{modelLabel(m)}
										</option>
									) : null,
								)}
							</optgroup>
						))}
					</select>
				</label>
			)}
			{settings && (
				<p class="llm-settings">
					{settings.models.length > 0 ? (
						<>
							{settings.baseUrl ? (
								<>
									{settings.model?.provider} at <code>{settings.baseUrl}</code>
								</>
							) : (
								settings.model?.provider
							)}
							, up to {settings.maxTries} tries.
						</>
					) : (
						"No models are set."
					)}{" "}
					<button type="button" class="link" onClick={() => vscodeApi.postMessage({ type: "openLlmSettings" })}>
						Settings
					</button>
				</p>
			)}
			<label
				class="toggle"
				title="When on, an answer whose type check times out is sent back to the LLM like any rejected answer. When off, the inference stops at the first timeout."
			>
				<input
					type="checkbox"
					checked={settings?.timeoutCountsAsFail ?? true}
					disabled={!settings}
					onChange={(e) =>
						vscodeApi.postMessage({
							type: "setTimeoutCountsAsFail",
							value: (e.target as HTMLInputElement).checked,
						})
					}
				/>
				<span>Count timeouts as failed tries</span>
			</label>
			<div class="btn-row">
				<button
					type="button"
					class="btn btn-primary"
					disabled={running || !settings?.model || !name}
					onClick={() => vscodeApi.postMessage({ type: "inferWithLlm" })}
				>
					{running ? "Inferring…" : name ? `Infer type of ${name}` : "Infer type"}
				</button>
			</div>
			{!name && <p class="note note-absent">Put the cursor in a top-level definition.</p>}
			<LlmStatusView status={state.llmStatus} />
		</>
	);
}

function App() {
	// Lazy init, so the restore runs once instead of on every render.
	// Saved by an older version, the state may lack newer fields.
	const [state, dispatch] = useReducer(reducer, initialState, (fallback) => ({
		...fallback,
		...vscodeApi.getState(),
	}));

	useEffect(() => {
		vscodeApi.setState(state);
	}, [state]);

	useEffect(() => {
		// [MessageEvent<unknown>] rather than the default [MessageEvent<any>]: with
		// [any] the guard below is only a runtime check, because dispatching the
		// raw data would compile just as happily. With [unknown] it is the only way
		// to reach [dispatch], so skipping it is a build error.
		function handler(event: MessageEvent<unknown>) {
			// Every recognised extension message maps straight onto a reducer action.
			if (!isFromExtension(event.data)) {
				console.warn("MLsem: ignoring unrecognised message from the extension", event.data);
				return;
			}
			dispatch(event.data);
		}
		window.addEventListener("message", handler);
		vscodeApi.postMessage({ type: "ready" });
		return () => window.removeEventListener("message", handler);
	}, []);

	// Why a tool has nothing to work on, if so.
	const noTarget = state.target ? undefined : "no definition at the cursor";
	// A part tool with no part: the server's reason, a sentence, as a phrase.
	const noParts = (tool: PartTool, none: string) => {
		const p = state.parts[tool];
		if (noTarget) return noTarget;
		if (p.lines.some((l) => l.parts.length > 0)) return undefined;
		const reason = p.reason?.replace(/\.$/, "");
		return reason ? reason.charAt(0).toLowerCase() + reason.slice(1) : none;
	};
	const noOverloads =
		noTarget ??
		(state.found ? undefined : state.overloadsFailure ? `failed: ${state.overloadsFailure}` : "does not typecheck");
	return (
		<TokenColors.Provider value={state.tokenColors}>
			<style>{css}</style>
			<div class="dashboard">
				<Section
					id="holes"
					title="Draft holes"
					state={state}
					dispatch={dispatch}
					unavailable={noTarget ?? (state.holes.length > 0 ? undefined : "no holes")}
				>
					<HolesTool state={state} dispatch={dispatch} />
				</Section>
				<Section
					id="extract"
					title="Extract repeated parts"
					state={state}
					dispatch={dispatch}
					unavailable={
						noTarget ?? (state.extract.lines.some((l) => l.groups.length > 0) ? undefined : "no repeated parts")
					}
				>
					<ExtractTool state={state} dispatch={dispatch} />
				</Section>
				<Section
					id="widen"
					title="Widen"
					state={state}
					dispatch={dispatch}
					unavailable={noParts("widen", "nothing to widen")}
				>
					<PartsTool tool="widen" state={state} dispatch={dispatch} />
				</Section>
				<Section
					id="simplify"
					title="Simplify"
					state={state}
					dispatch={dispatch}
					unavailable={noParts("simplify", "nothing to simplify")}
				>
					<PartsTool tool="simplify" state={state} dispatch={dispatch} />
				</Section>
				<Section id="merge" title="Overload merging" state={state} dispatch={dispatch} unavailable={noOverloads}>
					<MergeTool state={state} dispatch={dispatch} />
				</Section>
				<Section
					id="instantiate"
					title="Type variable instantiation"
					state={state}
					dispatch={dispatch}
					unavailable={noOverloads}
				>
					<InstantiateTool state={state} dispatch={dispatch} />
				</Section>
				<Section id="llm" title="LLM inference" state={state} dispatch={dispatch}>
					<LlmTool state={state} />
				</Section>
			</div>
		</TokenColors.Provider>
	);
}

const root = document.getElementById("root");
if (root) {
	render(<App />, root);
}
