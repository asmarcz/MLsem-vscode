import { render } from "preact";
import { useEffect, useReducer, useRef } from "preact/hooks";

declare function acquireVsCodeApi(): {
	postMessage(msg: unknown): void;
	getState(): AppState | undefined;
	setState(state: AppState): void;
};

const vscodeApi = acquireVsCodeApi();

interface Binding {
	name: string;
	declared: boolean;
}

// Per-overload (keyed by rendered text) map of variable name -> chosen concrete
// type string. Variables are independent per overload, so they are never shared
// across keys.
type Assignments = Record<string, Record<string, string>>;

interface AppState {
	found: boolean;
	binding: Binding | null;
	// Overloads are identified by their rendered text — the same identity the
	// server matches on — so selections/assignments survive edits and never
	// refer to a stale index.
	overloads: string[];
	// Free type-variable names of each overload, aligned by index with
	// [overloads].
	overloadVars: string[][];
	// Concrete-type suggestions for the instantiate comboboxes.
	concreteTypes: string[];
	// --- Merge tool ---
	selected: string[];
	preview: string | null;
	applying: boolean;
	staleSelection: boolean;
	error: string | null;
	// --- Instantiate tool ---
	assignments: Assignments;
	instPreview: string[] | null;
	instApplying: boolean;
	instStale: boolean;
	instError: string | null;
}

type ExtensionMessage =
	| {
			type: "overloads";
			found: boolean;
			binding: Binding;
			overloads: string[];
			overloadVars: string[][];
			concreteTypes: string[];
	  }
	| { type: "preview"; ok: boolean; text?: string; error?: string }
	| { type: "applied"; error?: string }
	| { type: "instantiatePreview"; ok: boolean; overloads?: string[]; error?: string }
	| { type: "instantiated"; error?: string };

type Action =
	| ExtensionMessage // OVERLOADS/PREVIEW/etc. are dispatched directly
	| { type: "TOGGLE"; text: string }
	| { type: "APPLYING" }
	| { type: "SET_ASSIGNMENT"; overload: string; variable: string; value: string }
	| { type: "INST_APPLYING" };

const initialState: AppState = {
	found: false,
	binding: null,
	overloads: [],
	overloadVars: [],
	concreteTypes: [],
	selected: [],
	preview: null,
	applying: false,
	staleSelection: false,
	error: null,
	assignments: {},
	instPreview: null,
	instApplying: false,
	instStale: false,
	instError: null,
};

// Drop assignment entries for overloads that no longer exist; report whether
// anything was dropped (so the instantiate tool can show a "types changed" note).
function reconcileAssignments(prev: Assignments, overloads: string[]): { kept: Assignments; dropped: boolean } {
	const kept: Assignments = {};
	let dropped = false;
	for (const [text, vars] of Object.entries(prev)) {
		if (overloads.includes(text)) kept[text] = vars;
		else dropped = true;
	}
	return { kept, dropped };
}

function reducer(state: AppState, action: Action): AppState {
	switch (action.type) {
		case "overloads": {
			if (!action.found) {
				return {
					...initialState,
					found: false,
					binding: action.binding,
				};
			}
			const sameBinding = state.found && state.binding?.name === action.binding?.name;
			// Merge: keep selections whose overload text still exists.
			const kept = sameBinding ? state.selected.filter((t) => action.overloads.includes(t)) : [];
			// Instantiate: keep assignments for overloads that still exist.
			const { kept: assignments, dropped } = sameBinding
				? reconcileAssignments(state.assignments, action.overloads)
				: { kept: {}, dropped: false };
			return {
				...state,
				found: true,
				binding: action.binding,
				overloads: action.overloads,
				overloadVars: action.overloadVars,
				concreteTypes: action.concreteTypes,
				selected: kept,
				preview: null,
				staleSelection: kept.length < state.selected.length,
				error: null,
				assignments,
				instPreview: null,
				instStale: dropped,
				instError: null,
			};
		}
		case "TOGGLE": {
			const t = action.text;
			const selected = state.selected.includes(t) ? state.selected.filter((x) => x !== t) : [...state.selected, t];
			return { ...state, selected, preview: null, error: null };
		}
		case "preview":
			return {
				...state,
				preview: action.ok ? (action.text ?? null) : null,
				error: action.ok ? null : (action.error ?? null),
			};
		case "APPLYING":
			return { ...state, applying: true };
		case "applied":
			return { ...state, applying: false, error: action.error ?? null };
		case "SET_ASSIGNMENT": {
			const forOverload = { ...(state.assignments[action.overload] ?? {}) };
			if (action.value === "") delete forOverload[action.variable];
			else forOverload[action.variable] = action.value;
			const assignments = { ...state.assignments };
			if (Object.keys(forOverload).length === 0) delete assignments[action.overload];
			else assignments[action.overload] = forOverload;
			return { ...state, assignments, instError: null };
		}
		case "INST_APPLYING":
			return { ...state, instApplying: true };
		case "instantiatePreview":
			return {
				...state,
				instPreview: action.ok ? (action.overloads ?? null) : null,
				instError: action.ok ? null : (action.error ?? null),
			};
		case "instantiated":
			return { ...state, instApplying: false, instError: action.error ?? null };
		default:
			return state;
	}
}

// Build the instantiations payload from the assignment map, skipping overloads
// with no (non-empty) assignments.
function buildInstantiations(assignments: Assignments) {
	return Object.entries(assignments)
		.map(([overload, vars]) => ({
			overload,
			assignments: Object.entries(vars).map(([variable, type]) => ({ var: variable, type })),
		}))
		.filter((i) => i.assignments.length > 0);
}

const css = `
*,
*::before,
*::after {
	box-sizing: border-box;
}

body {
	margin: 0;
	padding: 12px;
	background: var(--vscode-editor-background);
	color: var(--vscode-foreground);
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	/* Theme-adaptive borders/surfaces derived from the foreground colour, so
	   they stay visible in light themes where --vscode-panel-border is nearly
	   invisible. */
	--tk-border: color-mix(in srgb, var(--vscode-foreground) 30%, transparent);
	--tk-border-strong: color-mix(in srgb, var(--vscode-foreground) 55%, transparent);
	--tk-border-soft: color-mix(in srgb, var(--vscode-foreground) 20%, transparent);
	--tk-surface: color-mix(in srgb, var(--vscode-foreground) 3%, var(--vscode-editor-background));
}

.dashboard {
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.tool-card {
	border: 1px solid var(--tk-border);
	border-radius: 4px;
	padding: 12px;
	background: var(--tk-surface);
}

.tool-title {
	font-weight: 600;
	margin: 0 0 2px 0;
}

.tool-subtitle {
	margin: 0 0 12px 0;
	font-size: 0.85em;
	opacity: 0.7;
}

.layout {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 16px;
}

.column-title {
	font-weight: 600;
	margin: 0 0 8px 0;
	padding-bottom: 6px;
	border-bottom: 1px solid var(--tk-border-soft);
}

.overload-checkbox {
	position: absolute;
	width: 1px;
	height: 1px;
	margin: -1px;
	padding: 0;
	border: 0;
	overflow: hidden;
	clip: rect(0, 0, 0, 0);
	white-space: nowrap;
}

.overload-box {
	display: block;
	padding: 8px 10px;
	margin-bottom: 6px;
	border: 1px solid var(--tk-border);
	border-radius: 3px;
	cursor: pointer;
	background: var(--vscode-editor-background);
	font-family: var(--vscode-editor-font-family, monospace);
	font-size: 0.92em;
	white-space: pre-wrap;
	word-break: break-all;
	transition: border-color 0.1s, background 0.1s;
}

.overload-box:hover {
	border-color: var(--tk-border-strong, var(--vscode-foreground));
}

/* Selected: a light accent tint over the page background (so the text colour
   is untouched and stays readable in light themes) plus an accent border. */
.overload-box.selected {
	background: color-mix(in srgb, var(--vscode-focusBorder) 14%, var(--vscode-editor-background));
	border-color: var(--vscode-focusBorder);
}

.overload-box.selected:hover {
	border-color: var(--vscode-focusBorder);
}

.merge-area {
	display: flex;
	flex-direction: column;
	gap: 10px;
}

.merge-list {
	display: flex;
	flex-direction: column;
	gap: 4px;
	min-height: 32px;
}

.merge-item {
	padding: 6px 10px;
	border: 1px solid var(--tk-border);
	border-radius: 3px;
	background: var(--vscode-editor-background);
	font-family: var(--vscode-editor-font-family, monospace);
	font-size: 0.92em;
	white-space: pre-wrap;
	word-break: break-all;
}

/* Instantiate tool: one card per overload, fixed structure so the layout does
   not jump when the overload set or variable count changes. */
.inst-list {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.inst-overload {
	border: 1px solid var(--tk-border);
	border-radius: 3px;
	background: var(--vscode-editor-background);
	padding: 8px 10px;
}

.inst-overload-text {
	font-family: var(--vscode-editor-font-family, monospace);
	font-size: 0.92em;
	white-space: pre-wrap;
	word-break: break-all;
	margin-bottom: 8px;
}

.var-row {
	display: flex;
	flex-wrap: wrap;
	gap: 8px 12px;
}

.var-field {
	display: flex;
	align-items: center;
	gap: 6px;
}

.var-name {
	font-family: var(--vscode-editor-font-family, monospace);
	font-size: 0.9em;
	opacity: 0.9;
}

.var-input-wrap {
	position: relative;
	display: inline-flex;
	align-items: center;
}

.var-combobox {
	width: 13ch;
	padding: 2px 20px 2px 6px;
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, var(--tk-border));
	border-radius: 3px;
	font-family: var(--vscode-editor-font-family, monospace);
	font-size: 0.9em;
}

.var-combobox:focus {
	outline: 1px solid var(--vscode-focusBorder);
	outline-offset: -1px;
}

.var-clear {
	position: absolute;
	right: 4px;
	top: 50%;
	transform: translateY(-50%);
	display: flex;
	align-items: center;
	justify-content: center;
	width: 15px;
	height: 15px;
	padding: 0;
	border: none;
	border-radius: 50%;
	background: transparent;
	color: var(--vscode-input-foreground);
	opacity: 0.55;
	cursor: pointer;
	font-size: 13px;
	line-height: 1;
}

.var-clear:hover {
	opacity: 1;
	background: var(--tk-border-soft);
}

.preview-block {
	padding: 8px 10px;
	background: var(--vscode-editor-background);
	border: 1px solid var(--vscode-focusBorder);
	border-radius: 3px;
	font-family: var(--vscode-editor-font-family, monospace);
	font-size: 0.92em;
	white-space: pre-wrap;
	word-break: break-all;
}

.preview-lines {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.preview-placeholder {
	opacity: 0.5;
	font-style: italic;
}

.apply-btn {
	display: inline-block;
	padding: 6px 14px;
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
	border: none;
	border-radius: 3px;
	cursor: pointer;
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	align-self: flex-start;
}

.apply-btn:hover:not(:disabled) {
	background: var(--vscode-button-hoverBackground);
}

.apply-btn:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}

.stale-note {
	font-size: 0.85em;
	opacity: 0.75;
	margin-bottom: 4px;
}

.error-note {
	margin: 0 0 8px 0;
	padding: 6px 10px;
	border-radius: 3px;
	color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground));
	background: var(--vscode-inputValidation-errorBackground);
	border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
}

.empty-note {
	opacity: 0.6;
	font-style: italic;
	margin-top: 4px;
}

.not-found {
	opacity: 0.7;
	font-style: italic;
	margin-top: 16px;
}
`;

const DATALIST_ID = "mlsem-concrete-types";

function MergeTool({ state, dispatch }: { state: AppState; dispatch: (a: Action) => void }) {
	const applyingRef = useRef(false);

	// Request a merge preview whenever the selection changes and is non-empty.
	useEffect(() => {
		if (state.selected.length === 0 || !state.binding) return;
		vscodeApi.postMessage({ type: "requestPreview", name: state.binding.name, overloadTexts: state.selected });
	}, [state.selected, state.binding]);

	// Clear the synchronous guard once the extension replies.
	useEffect(() => {
		if (!state.applying) applyingRef.current = false;
	}, [state.applying]);

	function handleApply() {
		if (state.selected.length === 0 || applyingRef.current || !state.binding) return;
		applyingRef.current = true;
		dispatch({ type: "APPLYING" });
		vscodeApi.postMessage({ type: "apply", name: state.binding.name, overloadTexts: state.selected });
	}

	return (
		<section class="tool-card">
			<p class="tool-title">Merge overloads</p>
			<p class="tool-subtitle">Combine selected overloads into a single declared type.</p>
			{state.error && <p class="error-note">{state.error}</p>}
			{state.staleSelection && <p class="stale-note">Types changed — selection updated.</p>}
			<div class="layout">
				<div>
					<p class="column-title">
						Overloads for <code>{state.binding?.name ?? ""}</code>
					</p>
					{state.overloads.length === 0 && <p class="empty-note">No overloads available.</p>}
					{state.overloads.map((t) => (
						<label key={t} class={`overload-box${state.selected.includes(t) ? " selected" : ""}`}>
							<input
								type="checkbox"
								class="overload-checkbox"
								checked={state.selected.includes(t)}
								onChange={() => dispatch({ type: "TOGGLE", text: t })}
							/>
							{t}
						</label>
					))}
				</div>
				<div class="merge-area">
					<p class="column-title">Merge area</p>
					<div class="merge-list">
						{state.selected.length === 0 && <p class="empty-note">Select overloads on the left.</p>}
						{state.selected.map((t) => (
							<div key={t} class="merge-item">
								{t}
							</div>
						))}
					</div>
					<div>
						{state.preview ? (
							<div class="preview-block">{state.preview}</div>
						) : (
							<div class="preview-block preview-placeholder">
								{state.selected.length === 0 ? "Select overloads to see a preview." : "Loading preview…"}
							</div>
						)}
					</div>
					<button
						class="apply-btn"
						type="button"
						disabled={state.selected.length === 0 || state.applying}
						onClick={handleApply}
					>
						{state.applying ? "Applying…" : "Apply"}
					</button>
				</div>
			</div>
		</section>
	);
}

function InstantiateTool({ state, dispatch }: { state: AppState; dispatch: (a: Action) => void }) {
	const applyingRef = useRef(false);
	const hasAssignments = buildInstantiations(state.assignments).length > 0;

	// Debounced preview request whenever assignments change. When nothing is
	// assigned, clear any stale preview instead of requesting one.
	useEffect(() => {
		if (!state.binding) return;
		const instantiations = buildInstantiations(state.assignments);
		if (instantiations.length === 0) {
			dispatch({ type: "instantiatePreview", ok: true, overloads: undefined });
			return;
		}
		const name = state.binding.name;
		const timer = setTimeout(() => {
			vscodeApi.postMessage({ type: "requestInstantiatePreview", name, instantiations });
		}, 150);
		return () => clearTimeout(timer);
	}, [state.assignments, state.binding, dispatch]);

	useEffect(() => {
		if (!state.instApplying) applyingRef.current = false;
	}, [state.instApplying]);

	function handleApply() {
		if (!hasAssignments || applyingRef.current || !state.binding) return;
		applyingRef.current = true;
		dispatch({ type: "INST_APPLYING" });
		vscodeApi.postMessage({
			type: "applyInstantiate",
			name: state.binding.name,
			instantiations: buildInstantiations(state.assignments),
		});
	}

	return (
		<section class="tool-card">
			<p class="tool-title">Instantiate type variables</p>
			<p class="tool-subtitle">
				Pin a type variable to a concrete type, per overload. Variables are independent across overloads.
			</p>
			{state.instError && <p class="error-note">{state.instError}</p>}
			{state.instStale && <p class="stale-note">Types changed — assignments updated.</p>}
			<datalist id={DATALIST_ID}>
				{state.concreteTypes.map((t) => (
					<option key={t} value={t} />
				))}
			</datalist>
			<div class="inst-list">
				{state.overloads.length === 0 && <p class="empty-note">No overloads available.</p>}
				{state.overloads.map((text, i) => {
					const vars = state.overloadVars[i] ?? [];
					const assigned = state.assignments[text] ?? {};
					return (
						<div key={text} class="inst-overload">
							<div class="inst-overload-text">{text}</div>
							{vars.length === 0 ? (
								<p class="empty-note">No type variables.</p>
							) : (
								<div class="var-row">
									{vars.map((v) => (
										<label key={v} class="var-field">
											<span class="var-name">{v}</span>
											<span class="var-input-wrap">
												<input
													class="var-combobox"
													list={DATALIST_ID}
													placeholder="type…"
													value={assigned[v] ?? ""}
													onInput={(e) =>
														dispatch({
															type: "SET_ASSIGNMENT",
															overload: text,
															variable: v,
															value: (e.target as HTMLInputElement).value.trim(),
														})
													}
												/>
												{assigned[v] ? (
													<button
														type="button"
														class="var-clear"
														title="Clear"
														aria-label={`Clear ${v}`}
														onClick={() => dispatch({ type: "SET_ASSIGNMENT", overload: text, variable: v, value: "" })}
													>
														×
													</button>
												) : null}
											</span>
										</label>
									))}
								</div>
							)}
						</div>
					);
				})}
			</div>
			<div style="margin-top: 10px; display: flex; flex-direction: column; gap: 10px;">
				<div>
					{state.instPreview && state.instPreview.length > 0 ? (
						<div class="preview-block preview-lines">
							{state.instPreview.map((line) => (
								<div key={line}>{line}</div>
							))}
						</div>
					) : (
						<div class="preview-block preview-placeholder">
							{hasAssignments ? "Loading preview…" : "Assign a type variable to see a preview."}
						</div>
					)}
				</div>
				<button class="apply-btn" type="button" disabled={!hasAssignments || state.instApplying} onClick={handleApply}>
					{state.instApplying ? "Applying…" : "Apply"}
				</button>
			</div>
		</section>
	);
}

function App() {
	const saved = vscodeApi.getState();
	const [state, dispatch] = useReducer(reducer, saved ?? initialState);

	useEffect(() => {
		vscodeApi.setState(state);
	}, [state]);

	useEffect(() => {
		function handler(event: MessageEvent) {
			const msg = event.data as ExtensionMessage;
			// All extension messages map straight onto reducer actions.
			dispatch(msg as Action);
		}
		window.addEventListener("message", handler);
		vscodeApi.postMessage({ type: "ready" });
		return () => window.removeEventListener("message", handler);
	}, []);

	if (!state.found) {
		return (
			<>
				<style>{css}</style>
				<p class="not-found">No overloads found at this position.</p>
			</>
		);
	}

	return (
		<>
			<style>{css}</style>
			<div class="dashboard">
				<MergeTool state={state} dispatch={dispatch} />
				<InstantiateTool state={state} dispatch={dispatch} />
			</div>
		</>
	);
}

const root = document.getElementById("root");
if (root) {
	render(<App />, root);
}
