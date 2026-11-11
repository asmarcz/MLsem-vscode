// "Infer type with LLM": asks an LLM for the `val` line(s) of a definition and
// lets the language server check them, feeding the errors back until the
// definition checks or the tries run out.
//
// Any OpenAI-compatible endpoint works: the base URL and model are settings,
// the API key is kept in VS Code's secret storage. Only Chat Completions is
// used, since that is the part every compatible server implements.
//
// The server never trusts the answer: `mlsem/checkSignature` writes the
// candidate lines above the definition in a copy of the file and typechecks
// it, and the document is only edited once a candidate passes.

import OpenAI from "openai";
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import type { Config } from "./config";
import { type LlmStatus, triesText } from "./protocol";

const API_KEY = "mlsem.llm.apiKey";

interface Range {
	start: { line: number; character: number };
	end: { line: number; character: number };
}

// [line] is the definition's first line, 0-based.
type DefinitionAt = { ok: true; name: string; definition: string; line: number } | { ok: false; error: string };

// How the definition fares in the file's typecheck.
type DefinitionStatus =
	| { ok: true; status: "typed"; declared: boolean; types: string[] }
	| { ok: true; status: "errors"; errors: string[] }
	| { ok: true; status: "failed"; message: string }
	| { ok: true; status: "unknown" }
	| { ok: false; error: string };

// The definition's status, as a paragraph of the prompt.
function statusText(name: string, s: DefinitionStatus): string {
	if (!s.ok) return "";
	const vals = (types: string[]) => types.map((t) => `val ${name} : ${t}`).join("\n");
	switch (s.status) {
		case "typed":
			return s.declared
				? `It currently checks against its val line(s):\n\n${vals(s.types)}`
				: `Without a val, MLsem currently infers this type for it:\n\n${vals(s.types)}`;
		case "errors":
			return `Typechecking it currently fails with:\n${s.errors.map((e) => `- ${e}`).join("\n")}`;
		case "failed":
			// TODO: the server does not know which definition the file's
			// typecheck failed in (see [mark_failed] in the server), so this
			// cannot say whether it is this one.
			return `Typechecking this file as it is does not succeed: ${s.message}. It is not known in which definition.`;
		case "unknown":
			return "";
	}
}

type CheckResult =
	| { ok: true; edit: { range: Range; newText: string } }
	| { ok: false; errors?: string[]; error?: string };

const SYSTEM_PROMPT = `You write type signatures for MLsem, an ML-like language with set-theoretic types.

Answer with only the declaration line(s) for the requested definition, one per line:
val NAME : TYPE
No explanation and no code fences. Several val lines declare an overloaded definition: it is checked against each of them.

Type syntax:
- functions 't1 -> t2', tuples '(t1, t2)', type variables ''a', ''b'
- union 't1 | t2', intersection 't1 & t2', negation '~t', difference 't1 \\ t2'
- 'any', 'empty', base types 'int', 'bool', 'string', 'char', singletons such as '1', 'true', '()'
- sequences (lists) with regular expressions: '[ int* ]', '[ 'a+ ]', '[ 'a* bool? ]', '[ int+ bool+ ]'
- applied type definitions 't('a)', tagged values 'Node(t1, t2)'
- an intersection of arrows is an overloaded function, e.g. '(int -> int) & (bool -> bool)'

Use the types defined in the file. Give the most sensible type given the function's actual or intended usage.`;

// Every run reports here, wherever it was started from, so the type toolkit
// can show it.
const statusEmitter = new vscode.EventEmitter<LlmStatus>();
export const onLlmStatus = statusEmitter.event;
let lastStatus: LlmStatus = { state: "idle" };
export const llmStatus = () => lastStatus;
function report(status: LlmStatus) {
	lastStatus = status;
	statusEmitter.fire(status);
}

export async function setApiKey(context: vscode.ExtensionContext) {
	const key = await vscode.window.showInputBox({
		title: "MLsem: LLM API key",
		prompt: "API key for the endpoint in mlsem.llm.baseUrl. Leave empty for a local server that needs none.",
		password: true,
		ignoreFocusOut: true,
	});
	if (key === undefined) return undefined;
	await context.secrets.store(API_KEY, key);
	return key;
}

async function apiKey(context: vscode.ExtensionContext) {
	return (await context.secrets.get(API_KEY)) ?? (await setApiKey(context));
}

// The model chosen in the type toolkit, kept for the user across sessions
// and workspaces. When it is no longer in mlsem.llm.models, the first one.
const SELECTED_MODEL = "mlsem.llm.selectedModel";

export function selectedModel(context: vscode.ExtensionContext, config: Config): string | undefined {
	const models = config.llmModels;
	const chosen = context.globalState.get<string>(SELECTED_MODEL);
	return chosen !== undefined && models.includes(chosen) ? chosen : models[0];
}

export function selectModel(context: vscode.ExtensionContext, model: string) {
	return context.globalState.update(SELECTED_MODEL, model);
}

// The type part of each `val` line of [name] in [reply]. Lines for other names
// are ignored; if there are only such lines, all of them are taken.
export function parseVals(reply: string, name: string): string[] {
	const lines = reply
		.split("\n")
		.map((l) => /^\s*val\s+(\([^)]*\)|[^\s:]+)\s*:\s*(.+?)\s*$/.exec(l))
		.filter((m) => m !== null);
	const own = lines.filter((m) => m[1] === name || m[1] === `(${name})`);
	return (own.length > 0 ? own : lines).map((m) => m[2]);
}

function feedback(errors: string[]) {
	return `MLsem rejected these types:\n${errors.map((e) => `- ${e}`).join("\n")}\n\nAnswer again with only the val line(s).`;
}

type Outcome =
	| { kind: "cancelled" }
	| { kind: "failed"; error: string }
	| { kind: "exhausted"; errors: string[] }
	// A check timed out and timeouts do not count as failed tries: the run
	// stops there instead of asking again.
	| { kind: "timedOut"; vals: string[] }
	| { kind: "ok"; types: string[]; edit: { range: Range; newText: string } };

let running = false;

export async function inferTypeWithLlm(
	context: vscode.ExtensionContext,
	client: LanguageClient,
	config: Config,
	output: vscode.LogOutputChannel,
	uri?: vscode.Uri,
	position?: vscode.Position,
) {
	if (running) {
		vscode.window.showWarningMessage("MLsem: the LLM is already inferring a type.");
		return;
	}
	const editor = vscode.window.activeTextEditor;
	const document = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
	const pos = position ?? editor?.selection.active;
	if (!document || document.languageId !== "mlsem" || !pos) {
		vscode.window.showErrorMessage("Put the cursor in a definition of an MLsem file.");
		return;
	}
	const model = selectedModel(context, config);
	if (!model) {
		const open = await vscode.window.showErrorMessage("Add the models to use to mlsem.llm.models.", "Open settings");
		if (open) vscode.commands.executeCommand("workbench.action.openSettings", "mlsem.llm");
		return;
	}
	const key = await apiKey(context);
	if (key === undefined) return;

	const text = document.getText();
	const version = document.version;
	const at = { textDocument: { uri: document.uri.toString() }, text, position: pos };
	const def = await client.sendRequest<DefinitionAt>("mlsem/definitionAt", at);
	if (!def.ok) {
		vscode.window.showErrorMessage(def.error);
		return;
	}
	const name = def.name;

	// The SDK refuses an empty key; local servers ignore whatever is sent.
	const openai = new OpenAI({ baseURL: config.llmBaseUrl, apiKey: key || "none" });
	const maxTries = config.llmMaxTries;
	const timeoutCountsAsFail = config.llmTimeoutCountsAsFail;
	const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM_PROMPT }];
	output.info(`LLM: inferring the type of ${name} with ${model} at ${config.llmBaseUrl}`);

	let tries = 0;
	running = true;
	const outcome: Outcome = await vscode.window
		.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `MLsem: inferring the type of ${name}`,
				cancellable: true,
			},
			async (progress, token): Promise<Outcome> => {
				const abort = new AbortController();
				token.onCancellationRequested(() => abort.abort());

				// Typechecks the file unless the server already did, so it may
				// take until the timeout.
				progress.report({ message: "checking the definition" });
				let status: DefinitionStatus;
				try {
					status = await client.sendRequest<DefinitionStatus>("mlsem/definitionStatus", at);
				} catch (e) {
					status = { ok: true, status: "failed", message: e instanceof Error ? e.message : String(e) };
				}
				if (token.isCancellationRequested) return { kind: "cancelled" };
				const paragraph = statusText(name, status);
				output.info(`LLM: status of ${name}: ${paragraph || "unknown"}`);
				messages.push({
					role: "user",
					// The whole file: a definition may use later ones that have a val.
					content: `Here is the file:\n\n${text}\n\nWrite the val line(s) for this definition of \`${name}\`, at line ${def.line + 1}:\n\n${def.definition}${paragraph ? `\n\n${paragraph}` : ""}`,
				});

				let errors: string[] = [];
				while (tries < maxTries) {
					tries++;
					progress.report({ message: `try ${tries} of ${maxTries}` });
					report({ state: "running", name, tries, maxTries });
					let reply: string;
					try {
						const completion = await openai.chat.completions.create({ model, messages }, { signal: abort.signal });
						reply = completion.choices[0]?.message.content ?? "";
					} catch (e) {
						if (token.isCancellationRequested) return { kind: "cancelled" };
						return { kind: "failed", error: `The LLM request failed: ${e}` };
					}
					messages.push({ role: "assistant", content: reply });
					output.info(`LLM try ${tries}: ${reply.trim()}`);

					const types = parseVals(reply, name);
					if (types.length === 0) {
						errors = [`The answer has no line of the form \`val ${name} : TYPE\`.`];
					} else {
						let check: CheckResult;
						try {
							check = await client.sendRequest<CheckResult>("mlsem/checkSignature", { ...at, types });
						} catch (e) {
							// The server gives up on a check that takes too long.
							if (/timed out/i.test(String(e)) && !timeoutCountsAsFail) {
								if (token.isCancellationRequested) return { kind: "cancelled" };
								return { kind: "timedOut", vals: types.map((t) => `val ${name} : ${t}`) };
							}
							check = { ok: false, errors: [`Type checking against these types did not finish: ${e}`] };
						}
						if (token.isCancellationRequested) return { kind: "cancelled" };
						if (check.ok) return { kind: "ok", types, edit: check.edit };
						errors = check.errors ?? [check.error ?? "The definition does not check."];
					}
					output.info(`LLM try ${tries} rejected:\n${errors.join("\n")}`);
					messages.push({ role: "user", content: feedback(errors) });
				}
				return { kind: "exhausted", errors };
			},
		)
		.then(
			(o) => o,
			(e): Outcome => ({ kind: "failed", error: String(e) }),
		);
	running = false;

	const after = triesText(tries);
	switch (outcome.kind) {
		case "cancelled":
			output.info("LLM: cancelled");
			report({ state: "done", ok: false, name, tries, message: "Cancelled." });
			return;
		case "failed":
			output.error(outcome.error);
			report({ state: "done", ok: false, name, tries, message: outcome.error });
			vscode.window.showErrorMessage(`MLsem: ${outcome.error}`);
			return;
		case "timedOut": {
			const message = `Type checking the answer of try ${tries} timed out, so the inference of ${name} stopped there.`;
			output.warn(`LLM: ${message} ${outcome.vals.join(" ; ")}`);
			report({ state: "done", ok: false, name, tries, message, vals: outcome.vals });
			vscode.window.showWarningMessage(`MLsem: ${message}`);
			return;
		}
		case "exhausted": {
			const message = `No type of ${name} checked after ${after}. Last error: ${outcome.errors[0] ?? ""}`;
			output.warn(`LLM: ${message}`);
			report({ state: "done", ok: false, name, tries, message });
			const show = await vscode.window.showWarningMessage(`MLsem: ${message}`, "Show log");
			if (show) output.show();
			return;
		}
		case "ok": {
			const vals = outcome.types.map((t) => `val ${name} : ${t}`);
			if (document.version !== version) {
				const message = `The file changed while the type of ${name} was inferred, so it was not inserted. Found after ${after}: ${vals.join(" ; ")}`;
				report({ state: "done", ok: false, name, tries, message, vals });
				vscode.window.showWarningMessage(`MLsem: ${message}`);
				return;
			}
			const { start, end } = outcome.edit.range;
			const edit = new vscode.WorkspaceEdit();
			edit.replace(
				document.uri,
				new vscode.Range(start.line, start.character, end.line, end.character),
				outcome.edit.newText,
			);
			await vscode.workspace.applyEdit(edit);
			const message = `The LLM found a type of ${name} that checks after ${after}.`;
			output.info(`LLM: ${message}`);
			report({ state: "done", ok: true, name, tries, message, vals });
			vscode.window.showInformationMessage(`MLsem: ${message}`);
		}
	}
}
