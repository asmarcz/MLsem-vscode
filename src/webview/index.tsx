import { render } from "preact";
import { useEffect, useReducer, useRef } from "preact/hooks";
import css from "./styles.css";

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
