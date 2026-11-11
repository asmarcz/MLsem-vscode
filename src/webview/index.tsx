import { type ComponentChildren, render } from "preact";
import { useEffect, useReducer, useRef } from "preact/hooks";
import {
	type Binding,
	type ExtensionToWebview,
	type Instantiation,
	isFromExtension,
	type LlmAttempt,
	type LlmSettings,
	type LlmStatus,
	type Overload,
	triesText,
	type WebviewToExtension,
} from "../protocol";
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
	merge: ToolState<string>;
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
	// Collapsed sections, by id. Kept across bindings, like VS Code's panes.
	collapsed: Record<SectionId, boolean>;
}

type SectionId = "merge" | "instantiate" | "llm";

type Action =
	| ExtensionToWebview // "overloads", "preview" etc. are dispatched directly
	| { type: "TOGGLE_SECTION"; id: SectionId }
	| { type: "TOGGLE"; text: string }
	| { type: "APPLYING" }
	| { type: "SET_ASSIGNMENT"; overload: string; variable: string; value: string }
	| { type: "INST_APPLYING" }
	| { type: "INST_CLEAR_PREVIEW" };

const initialState: AppState = {
	found: false,
	binding: null,
	overloads: [],
	concreteTypes: [],
	selected: [],
	merge: initialToolState,
	assignments: {},
	instantiate: initialToolState,
	llmSettings: null,
	llmStatus: { state: "idle" },
	target: null,
	overloadsFailure: null,
	collapsed: { merge: false, instantiate: false, llm: false },
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
				assignments,
				instantiate: { ...state.instantiate, preview: null, stale: dropped, error: null },
			};
		}
		case "TOGGLE_SECTION":
			return { ...state, collapsed: { ...state.collapsed, [action.id]: !state.collapsed[action.id] } };
		case "llmSettings":
			return { ...state, llmSettings: action.settings };
		case "llmStatus":
			return { ...state, llmStatus: action.status };
		case "target":
			return { ...state, target: action.name };
		case "TOGGLE": {
			const t = action.text;
			const selected = state.selected.includes(t) ? state.selected.filter((x) => x !== t) : [...state.selected, t];
			return { ...state, selected, merge: { ...state.merge, preview: null, error: null } };
		}
		case "preview":
			return { ...state, merge: withPreview(state.merge, action.ok, action.text, action.error) };
		case "APPLYING":
			return { ...state, merge: { ...state.merge, applying: true } };
		case "applied":
			return { ...state, merge: withApplied(state.merge, action.error) };
		case "SET_ASSIGNMENT": {
			const forOverload = { ...(state.assignments[action.overload] ?? {}) };
			if (action.value === "") delete forOverload[action.variable];
			else forOverload[action.variable] = action.value;
			const assignments = { ...state.assignments };
			if (Object.keys(forOverload).length === 0) delete assignments[action.overload];
			else assignments[action.overload] = forOverload;
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

const DATALIST_ID = "mlsem-concrete-types";

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

function MergeTool({ state, dispatch }: { state: AppState; dispatch: (a: Action) => void }) {
	const merge = state.merge;
	const claimApply = useApplyGuard(merge.applying);

	// Request a merge preview whenever the selection changes and is non-empty.
	useEffect(() => {
		if (state.selected.length === 0 || !state.binding) return;
		vscodeApi.postMessage({ type: "requestPreview", name: state.binding.name, overloadTexts: state.selected });
	}, [state.selected, state.binding]);

	// append=false,keepOthers=true → Apply (scoped: merged replaces the selected,
	// the rest kept); append=false,keepOthers=false → Replace (full: merged only);
	// append=true → Insert (merged appended, all existing kept).
	function handleApply(append: boolean, keepOthers: boolean) {
		if (state.selected.length === 0 || !state.binding || !claimApply()) return;
		dispatch({ type: "APPLYING" });
		vscodeApi.postMessage({
			type: "apply",
			name: state.binding.name,
			overloadTexts: state.selected,
			append,
			keepOthers,
		});
	}

	return (
		<>
			<p class="note tool-subtitle">Combine selected overloads into a single declared type.</p>
			{merge.error && <p class="error-note">{merge.error}</p>}
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
							{text}
						</label>
					))}
				</div>
				<div class="merge-area">
					<p class="column-title">Merge area</p>
					<div class="merge-list">
						{state.selected.length === 0 && <p class="note note-absent empty-note">Select overloads on the left.</p>}
						{state.selected.map((t) => (
							<div key={t} class="surface code-text merge-item">
								{t}
							</div>
						))}
					</div>
					<div>
						{merge.preview ? (
							<div class="surface code-text preview-block">{merge.preview}</div>
						) : (
							<div class="surface code-text preview-block preview-placeholder">
								{state.selected.length === 0 ? "Select overloads to see a preview." : "Loading preview…"}
							</div>
						)}
					</div>
					<ActionRow
						titles={{
							apply: "Replace the selected overloads with the merged type; keep the rest",
							replace: "Replace ALL declarations with the merged type (drops the unselected overloads)",
							insert: "Add the merged type as a new declaration, keeping every existing one",
						}}
						disabled={state.selected.length === 0 || merge.applying}
						busy={merge.applying}
						onApply={() => handleApply(false, true)}
						onReplace={() => handleApply(false, false)}
						onInsert={() => handleApply(true, false)}
					/>
				</div>
			</div>
		</>
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
				Pin a type variable to a concrete type, per overload. Variables are independent across overloads.
			</p>
			{inst.error && <p class="error-note">{inst.error}</p>}
			{inst.stale && <p class="note stale-note">Types changed — assignments updated.</p>}
			<datalist id={DATALIST_ID}>
				{state.concreteTypes.map((t) => (
					<option key={t} value={t} />
				))}
			</datalist>
			<div class="inst-list">
				{state.overloads.length === 0 && <p class="note note-absent empty-note">No overloads available.</p>}
				{state.overloads.map(({ text, vars }) => {
					const assigned = state.assignments[text] ?? {};
					const rowAssigned = Object.keys(assigned).length > 0;
					return (
						<div key={text} class="surface inst-overload">
							<div class="inst-overload-main">
								<div class="code-text inst-overload-text">{text}</div>
								{vars.length === 0 ? (
									<p class="note note-absent empty-note">No type variables.</p>
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
															onClick={() =>
																dispatch({ type: "SET_ASSIGNMENT", overload: text, variable: v, value: "" })
															}
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
								<div key={i}>{line}</div>
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

// A collapsible section in the style of VS Code's view panes: a full-width
// header with a chevron and an uppercase title, and the body below it.
function Section({
	id,
	title,
	state,
	dispatch,
	children,
}: {
	id: SectionId;
	title: string;
	state: AppState;
	dispatch: (a: Action) => void;
	children: ComponentChildren;
}) {
	const expanded = !state.collapsed[id];
	return (
		<section class={expanded ? "pane expanded" : "pane"}>
			<h2 class="pane-header">
				<button
					type="button"
					class="pane-toggle"
					aria-expanded={expanded}
					aria-controls={`pane-${id}`}
					onClick={() => dispatch({ type: "TOGGLE_SECTION", id })}
				>
					<svg class="pane-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
						<path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.2" />
					</svg>
					{title}
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
									<div key={j}>{v}</div>
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
								<div key={i}>{v}</div>
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
					    provider since two providers may offer the same model. */}
					<select
						class="select"
						value={String(
							settings.models.findIndex(
								(m) => m.provider === settings.model?.provider && m.model === settings.model?.model,
							),
						)}
						disabled={running}
						onChange={(e) => {
							const model = settings.models[Number((e.target as HTMLSelectElement).value)];
							if (model) vscodeApi.postMessage({ type: "selectModel", model });
						}}
					>
						{[...new Set(settings.models.map((m) => m.provider))].map((provider) => (
							<optgroup key={provider} label={provider}>
								{settings.models.map((m, i) =>
									m.provider === provider ? (
										<option key={i} value={String(i)}>
											{m.model}
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
							{settings.model?.provider} at <code>{settings.baseUrl}</code>, up to {settings.maxTries} tries.
						</>
					) : (
						"No providers with models are set."
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

	const notFound = (
		<p class="note note-absent">
			{state.target && state.overloadsFailure ? (
				<>
					No overloads for <code>{state.target}</code>: {state.overloadsFailure}
				</>
			) : state.target ? (
				<>
					<code>{state.target}</code> does not typecheck, so it has no overloads.
				</>
			) : (
				"Put the cursor in a top-level definition."
			)}
		</p>
	);
	return (
		<>
			<style>{css}</style>
			<div class="dashboard">
				<Section id="merge" title="Overload merging" state={state} dispatch={dispatch}>
					{state.found ? <MergeTool state={state} dispatch={dispatch} /> : notFound}
				</Section>
				<Section id="instantiate" title="Type variable instantiation" state={state} dispatch={dispatch}>
					{state.found ? <InstantiateTool state={state} dispatch={dispatch} /> : notFound}
				</Section>
				<Section id="llm" title="LLM inference" state={state} dispatch={dispatch}>
					<LlmTool state={state} />
				</Section>
			</div>
		</>
	);
}

const root = document.getElementById("root");
if (root) {
	render(<App />, root);
}
