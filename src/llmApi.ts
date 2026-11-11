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

export function openAiConversation(
	baseUrl: string,
	apiKey: string,
	model: string,
	system: string,
	first: string,
): Conversation {
	// The SDK refuses an empty key; local servers ignore whatever is sent.
	const client = new OpenAI({ baseURL: baseUrl, apiKey: apiKey || "none" });
	const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
		{ role: "system", content: system },
		{ role: "user", content: first },
	];
	return {
		async ask(signal) {
			const completion = await client.chat.completions.create({ model, messages }, { signal });
			const text = completion.choices[0]?.message.content ?? "";
			messages.push({ role: "assistant", content: text });
			const u = completion.usage;
			const usage = u && {
				...newUsage(),
				prompt: u.prompt_tokens ?? 0,
				completion: u.completion_tokens ?? 0,
				cached: u.prompt_tokens_details?.cached_tokens ?? 0,
				reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
			};
			return { text, thinking: "", usage };
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
