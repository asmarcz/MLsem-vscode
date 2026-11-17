// The two ways the LLM inference talks to a model: an OpenAI-compatible Chat
// Completions endpoint, or Anthropic's native Messages API. Both are a
// conversation the loop in llm.ts asks for answers and adds feedback to.
//
// The native API reports how much of the output was thinking, takes an
// effort per model, and caches the prompt across tries; the OpenAI-compatible
// endpoints report less (Anthropic's leaves the details empty).

import type Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Effort } from "./protocol";

// Token counts of answers. [prompt] is all input tokens, of which [cached]
// were read from and [cacheWrite] written to the prompt cache; [reasoning]
// is the part of [completion] spent thinking. Only some APIs report the
// last three. [unreported] counts the answers without usage, whose tokens
// are missing from the totals.
export interface Usage {
	prompt: number;
	completion: number;
	cached: number;
	cacheWrite: number;
	reasoning: number;
	unreported: number;
}

export function newUsage(): Usage {
	return { prompt: 0, completion: 0, cached: 0, cacheWrite: 0, reasoning: 0, unreported: 0 };
}

export function addUsage(total: Usage, one: Usage) {
	for (const k of Object.keys(one) as (keyof Usage)[]) total[k] += one[k];
}

export function usageText(u: Usage): string {
	const prompt = [`${u.prompt} prompt tokens`];
	if (u.cached > 0) prompt.push(`${u.cached} read from cache`);
	if (u.cacheWrite > 0) prompt.push(`${u.cacheWrite} written to cache`);
	const completion = [`${u.completion} completion tokens`];
	if (u.reasoning > 0) completion.push(`${u.reasoning} of them thinking`);
	const text = `${prompt.join(", ")}; ${completion.join(", ")}`;
	if (u.unreported === 0) return text;
	return `${text} (${u.unreported === 1 ? "1 answer" : `${u.unreported} answers`} reported no usage)`;
}

export interface Answer {
	text: string;
	// A summary of the model's thinking, when the API returns one.
	thinking: string;
	// Undefined when the server reported no usage.
	usage: Usage | undefined;
	// Set when the model declined to answer, with the reason.
	refusal?: string;
}

export interface Conversation {
	// The model's answer to the conversation so far, which becomes part of it.
	ask(signal: AbortSignal): Promise<Answer>;
	// Add a user message, e.g. the errors of the last answer.
	tell(text: string): void;
}

// Fits the instruction and a few val lines; thinking counts towards it.
const MAX_TOKENS = 16000;

// A model of an OpenAI-compatible server's list, and whether it is loaded
// when the server says (unsloth studio does; most do not).
export interface ListedModel {
	id: string;
	loaded?: boolean;
}

// The models an OpenAI-compatible server lists (GET {baseUrl}/models, the
// ids of [data]), sorted alphabetically. Without a key, no Authorization header is
// sent: local servers need none, and some reject any token they do not know.
export async function listModels(baseUrl: string, apiKey: string | undefined, signal?: AbortSignal) {
	const url = `${baseUrl.replace(/\/+$/, "")}/models`;
	let res: Response;
	try {
		res = await fetch(url, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			signal: signal ?? AbortSignal.timeout(10_000),
		});
	} catch (e) {
		throw new Error(`could not reach ${url} (${causeText(e)})`);
	}
	if (!res.ok) throw new Error(`${url} answered ${res.status}${bodyText(await res.text().catch(() => ""))}`);
	const json = (await res.json().catch(() => undefined)) as { data?: unknown } | undefined;
	if (!Array.isArray(json?.data)) throw new Error(`${url} did not answer a list of models`);
	const models: ListedModel[] = [];
	for (const m of json.data as { id?: unknown; loaded?: unknown }[]) {
		if (typeof m?.id !== "string" || m.id.trim() === "" || models.some((n) => n.id === m.id)) continue;
		models.push(typeof m.loaded === "boolean" ? { id: m.id, loaded: m.loaded } : { id: m.id });
	}
	return models.sort((a, b) => a.id.localeCompare(b.id, "en", { sensitivity: "base", numeric: true }));
}

// Why a request did not reach its server: the code of the network error
// under it (ECONNREFUSED under Node's "fetch failed"), the innermost
// message, or a timeout.
function causeText(e: unknown): string {
	if (e instanceof Error && e.name === "TimeoutError") return "no answer within 10 s";
	let message = String(e);
	for (let c: unknown = e; c instanceof Error; c = c.cause) {
		const code = (c as { code?: unknown }).code;
		if (typeof code === "string") return code;
		message = c.message;
	}
	return message;
}

// The message of an error answer, shortened: ": <message>", or "".
function bodyText(body: string): string {
	let message = body.trim();
	try {
		const j = JSON.parse(body);
		const m = j?.error?.message ?? j?.error ?? j?.detail ?? j?.message;
		if (typeof m === "string") message = m;
	} catch {
		// Not JSON: the text itself.
	}
	message = message.replace(/\s+/g, " ");
	if (message.length > 120) message = `${message.slice(0, 117)}...`;
	return message ? `: ${message}` : "";
}

// What went wrong with a request to an OpenAI-compatible server, for the
// panel and the notification: the usual causes with local servers named.
export function openAiErrorText(e: unknown, baseUrl: string, model: string): string {
	if (e instanceof OpenAI.APIConnectionTimeoutError) return `${baseUrl} did not answer in time.`;
	if (e instanceof OpenAI.APIConnectionError)
		return `Could not reach ${baseUrl} (${causeText(e)}). Is the server running?`;
	if (e instanceof OpenAI.APIError) {
		// Without the status the SDK puts first, and the final full stop
		// some servers end with, as a sentence follows.
		const message = e.message.replace(/^\d+\s*/, "").replace(/\.\s*$/, "");
		if (e.status === 401 || e.status === 403)
			return `${baseUrl} rejected the request (${e.status}: ${message}). Set its key with "MLsem: Set LLM API key", or leave the key empty for a server that needs none.`;
		if (e.status === 404 || e.status === 400 || e.status === 503)
			return `${baseUrl} answered ${e.status}: ${message}. Is ${model} available and loaded on the server?`;
		return `${baseUrl} answered ${e.status ?? "an error"}: ${message}`;
	}
	return String(e);
}

// The answer and the thinking in a reply's content. Reasoning models served
// without a reasoning parser put their thinking in the content, between
// <think> and </think>; a chat template that opens the block itself leaves
// only the </think>. A block that never closes is all thinking (the answer
// ran out of tokens).
export function splitThinking(content: string): { text: string; thinking: string } {
	const thinking: string[] = [];
	let text = content.replace(/<think>([\s\S]*?)<\/think>/g, (_, t: string) => {
		thinking.push(t);
		return "";
	});
	const close = text.lastIndexOf("</think>");
	if (close >= 0) {
		thinking.push(text.slice(0, close));
		text = text.slice(close + "</think>".length);
	}
	const open = text.indexOf("<think>");
	if (open >= 0) {
		thinking.push(text.slice(open + "<think>".length));
		text = text.slice(0, open);
	}
	return { text: text.trim(), thinking: thinking.map((t) => t.trim()).join("\n") };
}

export function openAiConversation(
	baseUrl: string,
	apiKey: string | undefined,
	model: string,
	system: string,
	first: string,
): Conversation {
	// The SDK refuses an empty key, and sends whatever it is given as a
	// bearer token. Without a key the header is left out: local servers need
	// none, and some reject any token they do not know.
	const client = new OpenAI({
		baseURL: baseUrl,
		apiKey: apiKey || "none",
		...(apiKey ? {} : { defaultHeaders: { Authorization: null } }),
	});
	const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
		{ role: "system", content: system },
		{ role: "user", content: first },
	];
	return {
		async ask(signal) {
			let completion: OpenAI.Chat.ChatCompletion;
			try {
				completion = await client.chat.completions.create({ model, messages }, { signal });
			} catch (e) {
				if (signal.aborted) throw e;
				throw new Error(openAiErrorText(e, baseUrl, model));
			}
			const message = completion.choices[0]?.message;
			const { text, thinking } = splitThinking(message?.content ?? "");
			// The reasoning of servers that parse it out of the content
			// (llama.cpp, vLLM, LM Studio: reasoning_content; Ollama: reasoning).
			const separate = message as { reasoning_content?: unknown; reasoning?: unknown } | undefined;
			const reasoning = [separate?.reasoning_content, separate?.reasoning].find(
				(r): r is string => typeof r === "string" && r.trim() !== "",
			);
			// The answer alone goes back: reasoning models expect their earlier
			// thinking left out of the conversation.
			messages.push({ role: "assistant", content: text });
			const u = completion.usage;
			const usage = u && {
				...newUsage(),
				prompt: u.prompt_tokens ?? 0,
				completion: u.completion_tokens ?? 0,
				cached: u.prompt_tokens_details?.cached_tokens ?? 0,
				reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
			};
			return { text, thinking: [reasoning, thinking].filter(Boolean).join("\n"), usage };
		},
		tell(text) {
			messages.push({ role: "user", content: text });
		},
	};
}

export function anthropicConversation(
	client: Anthropic,
	model: string,
	effort: Effort | undefined,
	system: string,
	first: string,
): Conversation {
	const messages: Anthropic.MessageParam[] = [{ role: "user", content: first }];
	return {
		async ask(signal) {
			const response = await client.messages.create(
				{
					model,
					max_tokens: MAX_TOKENS,
					system,
					messages,
					// The model decides how much to think; the summary is logged.
					thinking: { type: "adaptive", display: "summarized" },
					...(effort ? { output_config: { effort } } : {}),
					// Caches the conversation so far, so a retry pays the cache
					// rate for the file instead of the full input rate.
					cache_control: { type: "ephemeral" },
				},
				{ signal },
			);
			// The whole content, thinking blocks included: the API requires
			// them back unchanged in later requests.
			messages.push({ role: "assistant", content: response.content });
			const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
			const thinking = response.content.flatMap((b) => (b.type === "thinking" ? [b.thinking] : [])).join("\n");
			const u = response.usage;
			const usage = {
				...newUsage(),
				prompt: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
				completion: u.output_tokens,
				cached: u.cache_read_input_tokens ?? 0,
				cacheWrite: u.cache_creation_input_tokens ?? 0,
				reasoning: u.output_tokens_details?.thinking_tokens ?? 0,
			};
			const refusal =
				response.stop_reason === "refusal"
					? (response.stop_details?.explanation ?? response.stop_details?.category ?? "no reason given")
					: undefined;
			return { text, thinking, usage, refusal };
		},
		tell(text) {
			messages.push({ role: "user", content: text });
		},
	};
}
