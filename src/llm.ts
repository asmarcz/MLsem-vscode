// "Infer type with LLM": asks an LLM for the `val` line(s) of a definition and
// lets the language server check them, feeding the errors back until the
// definition checks or the tries run out.
//
// Models come from any OpenAI-compatible endpoint (mlsem.llm.providers: base
// URL and models, or without models those its server lists; only Chat
// Completions is used, since every compatible server implements it), or
// from Anthropic's native API (mlsem.llm.anthropic:
// models with an effort each). See llmApi.ts. API keys are kept in VS Code's
// secret storage; the native API also finds ANTHROPIC_API_KEY or an
// `ant auth login` profile.
//
// The server never trusts the answer: `mlsem/checkSignature` writes the
// candidate lines above the definition in a copy of the file and typechecks
// it, and the document is only edited once a candidate passes.

import Anthropic from "@anthropic-ai/sdk";
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import type { Config, LlmProvider } from "./config";
import {
	addUsage,
	anthropicConversation,
	type Conversation,
	type ListedModel,
	listModels,
	newUsage,
	openAiConversation,
	usageText,
} from "./llmApi";
import { type LlmAttempt, type LlmModel, type LlmStatus, type ModelListing, sameModel, triesText } from "./protocol";
import type { CheckSignatureResult, DefinitionAt, DefinitionStatus, TextEdit } from "./serverProtocol";

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

// TODO: say that a definition taking its arguments one at a time
// (`let f x y = ...`) has a curried type ('a -> 'b -> 'c), not a tuple one.
// Haiku copied the tuple style of `val (+) : (int, int) -> int` and needed a
// second try on `bal`.
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
function reportStatus(status: LlmStatus) {
	lastStatus = status;
	statusEmitter.fire(status);
}

// Each OpenAI-compatible provider's API key, and the native Anthropic API's,
// in VS Code's secret storage.
const apiKeySecret = (provider: string) => `mlsem.llm.apiKey/${provider}`;
const ANTHROPIC_KEY = "mlsem.llm.anthropicApiKey";
// How the native Anthropic API is named as a provider, in the dropdown and
// the key picker.
export const ANTHROPIC_PROVIDER = "Anthropic API";

// Ask for and store the API key of [provider], or of a provider picked from
// mlsem.llm.providers and the native Anthropic API.
export async function setApiKey(context: vscode.ExtensionContext, config: Config, provider?: string) {
	let name = provider;
	if (name === undefined) {
		const names = [
			...config.llmProviders.map((p) => p.name),
			...(config.llmAnthropicModels.length > 0 ? [ANTHROPIC_PROVIDER] : []),
		];
		if (names.length === 0) {
			vscode.window.showErrorMessage("Add models to mlsem.llm.providers or mlsem.llm.anthropic first.");
			return undefined;
		}
		name = names.length === 1 ? names[0] : await vscode.window.showQuickPick(names, { title: "MLsem: LLM provider" });
		if (name === undefined) return undefined;
	}
	const native = name === ANTHROPIC_PROVIDER;
	const key = await vscode.window.showInputBox({
		title: `MLsem: API key of ${name}`,
		prompt: native
			? "Leave empty to use ANTHROPIC_API_KEY or your `ant auth login` profile."
			: "Leave empty for a local server that needs none.",
		password: true,
		ignoreFocusOut: true,
	});
	if (key === undefined) return undefined;
	if (native && key === "") await context.secrets.delete(ANTHROPIC_KEY);
	else await context.secrets.store(native ? ANTHROPIC_KEY : apiKeySecret(name), key);
	// Its models may be listed with the new key.
	if (!native) void discoverModels(context, config, { force: true, only: name });
	return key;
}

// The key of [provider] (empty: none), asked for when none is stored yet,
// unless its server listed its models without one: then it needs none.
async function apiKey(context: vscode.ExtensionContext, config: Config, provider: LlmProvider) {
	const stored = await context.secrets.get(apiKeySecret(provider.name));
	if (stored !== undefined) return stored;
	if (listings.get(listingKey(provider))?.state === "listed") return "";
	return await setApiKey(context, config, provider.name);
}

// ---- Models listed by providers without a list of models ----
//
// A provider of mlsem.llm.providers without [models] offers the models its
// server lists (GET /models), asked with its stored key if any, never
// prompting for one. Listed once per session, again on refresh or when a
// key is set; a failure is shown in the toolkit, not as a notification.

type Listing =
	| { state: "listing"; done: Promise<void> }
	| { state: "listed"; models: ListedModel[] }
	| { state: "failed"; error: string };

// By provider name and base URL, so that a new URL lists again.
const listings = new Map<string, Listing>();
const listingKey = (p: LlmProvider) => `${p.name}\n${p.baseUrl}`;
const listingEmitter = new vscode.EventEmitter<void>();
// Fired when a listing starts or ends.
export const onModelsListed = listingEmitter.event;

// List the models of the providers without a list of models: those not
// listed yet, or with [force] all of them (or only [only]). Resolves when
// every listing asked for is done.
export async function discoverModels(
	context: vscode.ExtensionContext,
	config: Config,
	{ force = false, only }: { force?: boolean; only?: string } = {},
): Promise<void> {
	const pending = config.llmProviders
		.filter((p) => p.models === undefined && (only === undefined || p.name === only))
		.map((p) => {
			const key = listingKey(p);
			const current = listings.get(key);
			if (current?.state === "listing") return current.done;
			if (current && !force) return undefined;
			const done = (async () => {
				let listing: Listing;
				try {
					const secret = await context.secrets.get(apiKeySecret(p.name));
					listing = { state: "listed", models: await listModels(p.baseUrl, secret || undefined) };
				} catch (e) {
					listing = { state: "failed", error: e instanceof Error ? e.message : String(e) };
				}
				listings.set(key, listing);
				listingEmitter.fire();
			})();
			listings.set(key, { state: "listing", done });
			listingEmitter.fire();
			return done;
		});
	await Promise.all(pending);
}

// How the listing of each provider without a list of models went.
export function modelListings(config: Config): ModelListing[] {
	return config.llmProviders.flatMap((p): ModelListing[] => {
		if (p.models !== undefined) return [];
		const l = listings.get(listingKey(p));
		if (!l || l.state === "listing") return [{ provider: p.name, state: "listing" }];
		if (l.state === "failed") return [{ provider: p.name, state: "failed", error: l.error }];
		return [{ provider: p.name, state: "listed", count: l.models.length }];
	});
}

// The models of [p]: its own list, or the one its server gave.
function providerModels(p: LlmProvider): ListedModel[] {
	if (p.models !== undefined) return p.models.map((id) => ({ id }));
	const l = listings.get(listingKey(p));
	return l?.state === "listed" ? l.models : [];
}

// A client for the native Anthropic API: with the stored key, or else the
// SDK's own lookup (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, an `ant auth
// login` profile). Undefined, with the reason shown, when it finds none.
async function anthropicClient(context: vscode.ExtensionContext): Promise<Anthropic | undefined> {
	const key = await context.secrets.get(ANTHROPIC_KEY);
	try {
		return key ? new Anthropic({ apiKey: key }) : new Anthropic();
	} catch (e) {
		vscode.window.showErrorMessage(`MLsem: no credentials for the Anthropic API (${e}). ${ANTHROPIC_CREDENTIALS}`);
		return undefined;
	}
}

const ANTHROPIC_CREDENTIALS =
	"Set a key with `MLsem: Set LLM API key`, set ANTHROPIC_API_KEY, or run `ant auth login`.";

// The model chosen in the type toolkit, kept for the user across sessions
// and workspaces. When it is no longer among the configured models, the
// first one.
const SELECTED_MODEL = "mlsem.llm.selectedModel";

export function allModels(config: Config): LlmModel[] {
	return [
		...config.llmProviders.flatMap((p) =>
			providerModels(p).map(
				(m): LlmModel => ({
					api: "openai",
					provider: p.name,
					model: m.id,
					...(m.loaded === false ? { notLoaded: true } : {}),
				}),
			),
		),
		...config.llmAnthropicModels.map(
			(m): LlmModel => ({ api: "anthropic", provider: ANTHROPIC_PROVIDER, model: m.model, effort: m.effort }),
		),
	];
}

// The chosen model, with its provider's base URL for an OpenAI-compatible one.
export function selectedModel(
	context: vscode.ExtensionContext,
	config: Config,
): (LlmModel & { baseUrl?: string }) | undefined {
	const models = allModels(config);
	const chosen = context.globalState.get<LlmModel>(SELECTED_MODEL);
	const model = (chosen && models.find((m) => sameModel(m, chosen))) || models[0];
	if (!model) return undefined;
	if (model.api === "anthropic") return model;
	return { ...model, baseUrl: config.llmProviders.find((p) => p.name === model.provider)?.baseUrl };
}

export function selectModel(context: vscode.ExtensionContext, model: LlmModel) {
	const { api, provider, model: name, effort } = model;
	return context.globalState.update(SELECTED_MODEL, { api, provider, model: name, effort });
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
	| { kind: "ok"; types: string[]; edit: TextEdit };

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
	// The chosen model may be one a provider lists.
	await discoverModels(context, config);
	const chosen = selectedModel(context, config);
	if (!chosen) {
		const failed = modelListings(config).flatMap((l) =>
			l.state === "failed" ? [`${l.provider}: could not list models: ${l.error}`] : [],
		);
		const open = await vscode.window.showErrorMessage(
			failed.length > 0
				? `No LLM models. ${failed.join("; ")}`
				: "Add models to mlsem.llm.providers or mlsem.llm.anthropic.",
			"Open settings",
		);
		if (open) vscode.commands.executeCommand("workbench.action.openSettings", "mlsem.llm");
		return;
	}
	const { model, baseUrl } = chosen;
	// Builds the conversation once the first message is known.
	let start: (first: string) => Conversation;
	if (chosen.api === "anthropic") {
		const anthropic = await anthropicClient(context);
		if (!anthropic) return;
		start = (first) => anthropicConversation(anthropic, model, chosen.effort, SYSTEM_PROMPT, first);
	} else {
		const provider = config.llmProviders.find((p) => p.name === chosen.provider);
		if (baseUrl === undefined || provider === undefined) return;
		const key = await apiKey(context, config, provider);
		if (key === undefined) return;
		start = (first) => openAiConversation(baseUrl, key || undefined, model, SYSTEM_PROMPT, first);
	}
	const where = chosen.api === "anthropic" ? ANTHROPIC_PROVIDER : `${chosen.provider} at ${baseUrl}`;
	const effort = chosen.effort ? ` at effort ${chosen.effort}` : "";

	const text = document.getText();
	const version = document.version;
	const at = { textDocument: { uri: document.uri.toString() }, text, position: pos };
	const def = await client.sendRequest<DefinitionAt>("mlsem/definitionAt", at);
	if (!def.ok) {
		vscode.window.showErrorMessage(def.error);
		return;
	}
	if (!def.body) {
		vscode.window.showErrorMessage(`${def.name} has no definition to infer a type from.`);
		return;
	}
	const name = def.name;

	const maxTries = config.llmMaxTries;
	const timeoutCountsAsFail = config.llmTimeoutCountsAsFail;
	output.info(`LLM: inferring the type of ${name} with ${model}${effort} of ${where}`);

	let tries = 0;
	// What each answer proposed and what came of it, in order.
	const attempts: LlmAttempt[] = [];
	// Tokens of all answers, for comparing costs (logged, not shown).
	const usage = newUsage();
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
				const conversation = start(
					// The whole file: a definition may use later ones that have a val.
					`Here is the file:\n\n${text}\n\nWrite the val line(s) for this definition of \`${name}\`, at line ${def.line + 1}:\n\n${def.definition}${paragraph ? `\n\n${paragraph}` : ""}`,
				);

				let errors: string[] = [];
				while (tries < maxTries) {
					tries++;
					progress.report({ message: `try ${tries} of ${maxTries}` });
					reportStatus({ state: "running", name, tries, maxTries, attempts: [...attempts] });
					let reply: string;
					try {
						const answer = await conversation.ask(abort.signal);
						reply = answer.text;
						if (answer.usage) addUsage(usage, answer.usage);
						else usage.unreported++;
						output.info(
							`LLM try ${tries} tokens: ${answer.usage ? usageText(answer.usage) : "not reported by the server"}`,
						);
						if (answer.thinking.trim()) output.info(`LLM try ${tries} thinking: ${answer.thinking.trim()}`);
						if (answer.refusal !== undefined) {
							return { kind: "failed", error: `The model declined to answer: ${answer.refusal}` };
						}
					} catch (e) {
						if (token.isCancellationRequested) return { kind: "cancelled" };
						const hint = e instanceof Anthropic.AuthenticationError ? ` ${ANTHROPIC_CREDENTIALS}` : "";
						const message = e instanceof Error ? e.message : String(e);
						return { kind: "failed", error: `The LLM request failed: ${message}${hint}` };
					}
					output.info(`LLM try ${tries}: ${reply.trim()}`);

					const types = parseVals(reply, name);
					const vals = types.map((t) => `val ${name} : ${t}`);
					if (types.length === 0) {
						errors = [`The answer has no line of the form \`val ${name} : TYPE\`.`];
						attempts.push({ vals, result: "no val line", errors });
					} else {
						let check: CheckSignatureResult;
						let timedOut = false;
						try {
							check = await client.sendRequest<CheckSignatureResult>("mlsem/checkSignature", { ...at, types });
						} catch (e) {
							// The server gives up on a check that takes too long.
							timedOut = /timed out/i.test(String(e));
							if (timedOut && !timeoutCountsAsFail) {
								attempts.push({ vals, result: "timed out" });
								if (token.isCancellationRequested) return { kind: "cancelled" };
								return { kind: "timedOut", vals };
							}
							check = { ok: false, errors: [`Type checking against these types did not finish: ${e}`] };
						}
						if (token.isCancellationRequested) return { kind: "cancelled" };
						if (check.ok) {
							attempts.push({ vals, result: "checks" });
							return { kind: "ok", types, edit: check.edit };
						}
						errors = check.errors ?? [check.error ?? "The definition does not check."];
						attempts.push({ vals, result: timedOut ? "timed out" : "rejected", errors });
					}
					output.info(`LLM try ${tries} rejected:\n${errors.join("\n")}`);
					conversation.tell(feedback(errors));
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
	output.info(`LLM: ${name} used ${usageText(usage)} in ${after} with ${model}${effort} of ${where}`);
	// One line per run, for grepping and comparing.
	output.info(
		`LLM usage ${JSON.stringify({ definition: name, api: chosen.api, provider: chosen.provider, model, effort: chosen.effort ?? null, tries, outcome: outcome.kind, ...usage })}`,
	);
	const report = (s: { ok: boolean; message: string; vals?: string[] }) =>
		reportStatus({ state: "done", name, tries, attempts, ...s });
	switch (outcome.kind) {
		case "cancelled":
			output.info("LLM: cancelled");
			report({ ok: false, message: "Cancelled." });
			return;
		case "failed":
			output.error(outcome.error);
			report({ ok: false, message: outcome.error });
			vscode.window.showErrorMessage(`MLsem: ${outcome.error}`);
			return;
		case "timedOut": {
			const message = `Type checking the answer of try ${tries} timed out, so the inference of ${name} stopped there.`;
			output.warn(`LLM: ${message} ${outcome.vals.join(" ; ")}`);
			report({ ok: false, message, vals: outcome.vals });
			vscode.window.showWarningMessage(`MLsem: ${message}`);
			return;
		}
		case "exhausted": {
			const message = `No type of ${name} checked after ${after}. Last error: ${outcome.errors[0] ?? ""}`;
			output.warn(`LLM: ${message}`);
			report({ ok: false, message });
			const show = await vscode.window.showWarningMessage(`MLsem: ${message}`, "Show log");
			if (show) output.show();
			return;
		}
		case "ok": {
			const vals = outcome.types.map((t) => `val ${name} : ${t}`);
			if (document.version !== version) {
				const message = `The file changed while the type of ${name} was inferred, so it was not inserted. Found after ${after}: ${vals.join(" ; ")}`;
				report({ ok: false, message, vals });
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
			report({ ok: true, message, vals });
			vscode.window.showInformationMessage(`MLsem: ${message}`);
		}
	}
}
