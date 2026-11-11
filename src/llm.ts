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

const API_KEY = "mlsem.llm.apiKey";

interface Range {
	start: { line: number; character: number };
	end: { line: number; character: number };
}

type DefinitionAt = { ok: true; name: string; definition: string; source: string } | { ok: false; error: string };

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
- 'any', 'empty', base types such as 'int', 'bool', 'string', singletons such as '1', 'true', '()'
- sequences (lists) with regular expressions: '[ int* ]', '[ 'a+ ]', '[ 'a* bool? ]'
- applied type definitions 't('a)', tagged values 'Node(t1, t2)'
- an intersection of arrows is an overloaded function, e.g. '(int -> int) & (bool -> bool)'

Use the types defined in the file. Give the most precise type that the definition satisfies.`;

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

export async function inferTypeWithLlm(
	context: vscode.ExtensionContext,
	client: LanguageClient,
	config: Config,
	output: vscode.LogOutputChannel,
	uri?: vscode.Uri,
	position?: vscode.Position,
) {
	const editor = vscode.window.activeTextEditor;
	const document = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
	const pos = position ?? editor?.selection.active;
	if (!document || document.languageId !== "mlsem" || !pos) {
		vscode.window.showErrorMessage("Put the cursor in a definition of an MLsem file.");
		return;
	}
	const model = config.llmModel;
	if (!model) {
		const open = await vscode.window.showErrorMessage("Set the model to use in mlsem.llm.model.", "Open settings");
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

	// The SDK refuses an empty key; local servers ignore whatever is sent.
	const openai = new OpenAI({ baseURL: config.llmBaseUrl, apiKey: key || "none" });
	const maxTries = config.llmMaxTries;
	const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
		{ role: "system", content: SYSTEM_PROMPT },
		{
			role: "user",
			content: `Here is the file up to the definition of \`${def.name}\`:\n\n${def.source}\n\nWrite the val line(s) for \`${def.name}\`.`,
		},
	];
	output.info(`LLM: inferring the type of ${def.name} with ${model} at ${config.llmBaseUrl}`);

	const outcome = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `MLsem: inferring the type of ${def.name}`,
			cancellable: true,
		},
		async (progress, token) => {
			const abort = new AbortController();
			token.onCancellationRequested(() => abort.abort());
			let errors: string[] = [];
			for (let tries = 1; tries <= maxTries; tries++) {
				progress.report({ message: `try ${tries} of ${maxTries}` });
				let reply: string;
				try {
					const completion = await openai.chat.completions.create({ model, messages }, { signal: abort.signal });
					reply = completion.choices[0]?.message.content ?? "";
				} catch (e) {
					if (token.isCancellationRequested) return { kind: "cancelled" as const };
					return { kind: "failed" as const, tries, error: `The LLM request failed: ${e}` };
				}
				messages.push({ role: "assistant", content: reply });
				output.info(`LLM try ${tries}: ${reply.trim()}`);

				const types = parseVals(reply, def.name);
				if (types.length === 0) {
					errors = [`The answer has no line of the form \`val ${def.name} : TYPE\`.`];
				} else {
					let check: CheckResult;
					try {
						check = await client.sendRequest<CheckResult>("mlsem/checkSignature", { ...at, types });
					} catch (e) {
						// The server gives up on a check that takes too long.
						check = { ok: false, errors: [`Type checking against these types did not finish: ${e}`] };
					}
					if (token.isCancellationRequested) return { kind: "cancelled" as const };
					if (check.ok) return { kind: "ok" as const, tries, types, edit: check.edit };
					errors = check.errors ?? [check.error ?? "The definition does not check."];
				}
				output.info(`LLM try ${tries} rejected:\n${errors.join("\n")}`);
				messages.push({ role: "user", content: feedback(errors) });
			}
			return { kind: "exhausted" as const, tries: maxTries, errors };
		},
	);

	const tries = (n: number) => (n === 1 ? "1 try" : `${n} tries`);
	switch (outcome.kind) {
		case "cancelled":
			output.info("LLM: cancelled");
			return;
		case "failed":
			output.error(outcome.error);
			vscode.window.showErrorMessage(`MLsem: ${outcome.error}`);
			return;
		case "exhausted": {
			output.warn(`LLM: no type of ${def.name} checked after ${tries(outcome.tries)}`);
			const show = await vscode.window.showWarningMessage(
				`MLsem: the LLM found no type of ${def.name} that checks after ${tries(outcome.tries)}. Last error: ${outcome.errors[0] ?? ""}`,
				"Show log",
			);
			if (show) output.show();
			return;
		}
		case "ok": {
			if (document.version !== version) {
				vscode.window.showWarningMessage(
					`MLsem: the file changed while the type of ${def.name} was inferred, so it was not inserted. Found after ${tries(outcome.tries)}: ${outcome.types.map((t) => `val ${def.name} : ${t}`).join(" ; ")}`,
				);
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
			output.info(`LLM: ${def.name} checks after ${tries(outcome.tries)}`);
			vscode.window.showInformationMessage(
				`MLsem: the LLM found a type of ${def.name} that checks after ${tries(outcome.tries)}.`,
			);
		}
	}
}
