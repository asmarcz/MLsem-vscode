import { render } from "preact";
import { useEffect, useReducer, useRef } from "preact/hooks";

declare function acquireVsCodeApi(): {
	postMessage(msg: unknown): void;
	getState(): AppState | undefined;
	setState(state: AppState): void;
};

const vscodeApi = acquireVsCodeApi();

interface Overload {
	index: number;
	text: string;
}

interface Binding {
	name: string;
	declared: boolean;
}

interface AppState {
	found: boolean;
	binding: Binding | null;
	overloads: Overload[];
	selected: number[];
	preview: string | null;
	applying: boolean;
	staleSelection: boolean;
}

type ExtensionMessage =
	| { type: "overloads"; found: boolean; binding: Binding; overloads: Overload[] }
	| { type: "preview"; ok: boolean; text?: string; error?: string }
	| { type: "applied"; ok: boolean; error?: string };

type Action =
	| { type: "OVERLOADS"; found: boolean; binding: Binding; overloads: Overload[] }
	| { type: "TOGGLE"; index: number }
	| { type: "PREVIEW"; ok: boolean; text?: string; error?: string }
	| { type: "APPLYING" }
	| { type: "APPLIED"; ok: boolean; error?: string };

const initialState: AppState = {
	found: false,
	binding: null,
	overloads: [],
	selected: [],
	preview: null,
	applying: false,
	staleSelection: false,
};

function reconcileSelected(
	oldOverloads: Overload[],
	oldSelected: number[],
	newOverloads: Overload[],
): { selected: number[]; stale: boolean } {
	const selectedTexts = new Set(
		oldSelected.map((i) => oldOverloads.find((o) => o.index === i)?.text).filter(Boolean) as string[],
	);
	const newSelected: number[] = [];
	for (const o of newOverloads) {
		if (selectedTexts.has(o.text)) {
			newSelected.push(o.index);
		}
	}
	const stale = newSelected.length < oldSelected.length;
	return { selected: newSelected, stale };
}

function reducer(state: AppState, action: Action): AppState {
	switch (action.type) {
		case "OVERLOADS": {
			if (!action.found) {
				return {
					...state,
					found: false,
					binding: action.binding,
					overloads: [],
					selected: [],
					preview: null,
					staleSelection: false,
				};
			}
			// Same binding refreshed (e.g. after a save) → keep the selection by
			// matching overload text. A different binding → start clean.
			const sameBinding = state.found && state.binding?.name === action.binding?.name;
			const { selected, stale } = sameBinding
				? reconcileSelected(state.overloads, state.selected, action.overloads)
				: { selected: [] as number[], stale: false };
			return {
				...state,
				found: true,
				binding: action.binding,
				overloads: action.overloads,
				selected,
				preview: null,
				staleSelection: stale,
			};
		}
		case "TOGGLE": {
			const idx = action.index;
			const selected = state.selected.includes(idx)
				? state.selected.filter((i) => i !== idx)
				: [...state.selected, idx];
			return { ...state, selected, preview: null };
		}
		case "PREVIEW":
			return { ...state, preview: action.ok ? (action.text ?? null) : null };
		case "APPLYING":
			return { ...state, applying: true };
		case "APPLIED":
			return { ...state, applying: false };
		default:
			return state;
	}
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
	border-bottom: 1px solid var(--vscode-panel-border);
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
	border: 1px solid var(--vscode-panel-border);
	border-radius: 3px;
	cursor: pointer;
	background: var(--vscode-editorWidget-background);
	font-family: var(--vscode-editor-font-family, monospace);
	font-size: 0.92em;
	white-space: pre-wrap;
	word-break: break-all;
	transition: background 0.1s;
}

.overload-box:hover {
	background: var(--vscode-list-hoverBackground);
}

.overload-box.selected {
	background: var(--vscode-list-activeSelectionBackground);
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
	border: 1px solid var(--vscode-panel-border);
	border-radius: 3px;
	background: var(--vscode-editorWidget-background);
	font-family: var(--vscode-editor-font-family, monospace);
	font-size: 0.92em;
	white-space: pre-wrap;
	word-break: break-all;
}

.preview-block {
	padding: 8px 10px;
	background: var(--vscode-editorWidget-background);
	border: 1px solid var(--vscode-focusBorder);
	border-radius: 3px;
	font-family: var(--vscode-editor-font-family, monospace);
	font-size: 0.92em;
	white-space: pre-wrap;
	word-break: break-all;
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

function App() {
	const saved = vscodeApi.getState();
	const [state, dispatch] = useReducer(reducer, saved ?? initialState);
	// Synchronous re-entrancy guard: reducer state only updates on the next
	// render, so rapid clicks would all read applying === false and post several
	// "apply" messages before the button disables. A ref blocks them now.
	const applyingRef = useRef(false);

	// persist state on every change
	useEffect(() => {
		vscodeApi.setState(state);
	}, [state]);

	// request preview whenever selection changes and is non-empty
	useEffect(() => {
		if (state.selected.length === 0) return;
		vscodeApi.postMessage({ type: "requestPreview", indices: state.selected });
	}, [state.selected]);

	// listen for messages from the extension
	useEffect(() => {
		function handler(event: MessageEvent) {
			const msg = event.data as ExtensionMessage;
			if (msg.type === "overloads") {
				dispatch({ type: "OVERLOADS", found: msg.found, binding: msg.binding, overloads: msg.overloads });
			} else if (msg.type === "preview") {
				dispatch({ type: "PREVIEW", ok: msg.ok, text: msg.text, error: msg.error });
			} else if (msg.type === "applied") {
				applyingRef.current = false;
				dispatch({ type: "APPLIED", ok: msg.ok, error: msg.error });
			}
		}
		window.addEventListener("message", handler);
		// signal ready to get initial overloads
		vscodeApi.postMessage({ type: "ready" });
		return () => window.removeEventListener("message", handler);
	}, []);

	function handleToggle(index: number) {
		dispatch({ type: "TOGGLE", index });
	}

	function handleApply() {
		if (state.selected.length === 0 || applyingRef.current) return;
		applyingRef.current = true;
		dispatch({ type: "APPLYING" });
		vscodeApi.postMessage({ type: "apply", indices: state.selected });
	}

	if (!state.found) {
		return (
			<>
				<style>{css}</style>
				<p class="not-found">No overloads found at this position.</p>
			</>
		);
	}

	const selectedOverloads = state.selected
		.map((i) => state.overloads.find((o) => o.index === i))
		.filter(Boolean) as Overload[];

	return (
		<>
			<style>{css}</style>
			{state.staleSelection && <p class="stale-note">Types changed — selection updated.</p>}
			<div class="layout">
				<div>
					<p class="column-title">
						Overloads for <code>{state.binding?.name ?? ""}</code>
					</p>
					{state.overloads.length === 0 && <p class="empty-note">No overloads available.</p>}
					{state.overloads.map((o) => (
						<label key={o.index} class={`overload-box${state.selected.includes(o.index) ? " selected" : ""}`}>
							<input
								type="checkbox"
								class="overload-checkbox"
								checked={state.selected.includes(o.index)}
								onChange={() => handleToggle(o.index)}
							/>
							{o.text}
						</label>
					))}
				</div>
				<div class="merge-area">
					<p class="column-title">Merge area</p>
					<div class="merge-list">
						{selectedOverloads.length === 0 && <p class="empty-note">Click overloads on the left to select them.</p>}
						{selectedOverloads.map((o) => (
							<div key={o.index} class="merge-item">
								{o.text}
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
		</>
	);
}

const root = document.getElementById("root");
if (root) {
	render(<App />, root);
}
