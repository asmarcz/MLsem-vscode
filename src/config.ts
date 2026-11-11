import * as vscode from "vscode";

import type { Effort } from "./protocol";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

// A model of mlsem.llm.anthropic, with the effort to use it at, if not its
// default.
export interface AnthropicModel {
	model: string;
	effort?: Effort;
}

export interface LlmProvider {
	name: string;
	baseUrl: string;
	models: string[];
}

// Inspired by:
// https://github.com/mun-lang/vscode-extension/blob/bbe1ebde2879ac4af853ad5f4bf43911c77a3c26/src/config.ts
export class Config {
	readonly rootSection = "mlsem";

	private get cfg(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration(this.rootSection);
	}

	get isTrace(): boolean {
		const trace = this.cfg.get<string>("trace.server");
		return trace === "messages" || trace === "verbose";
	}

	get hoverOverloadColors(): boolean {
		return this.cfg.get<boolean>("hover.overloadColors") ?? true;
	}

	// The providers of mlsem.llm.providers in the order given, skipping those
	// without a base URL, and empty or repeated model names.
	get llmProviders(): LlmProvider[] {
		const providers = this.cfg.get<unknown>("llm.providers");
		if (typeof providers !== "object" || providers === null) return [];
		return Object.entries(providers).flatMap(([name, p]): LlmProvider[] => {
			if (typeof p !== "object" || p === null) return [];
			const { baseUrl, models } = p as { baseUrl?: unknown; models?: unknown };
			if (typeof baseUrl !== "string" || baseUrl.trim() === "") return [];
			const names = Array.isArray(models)
				? models.filter((m): m is string => typeof m === "string" && m.trim() !== "")
				: [];
			return [{ name, baseUrl, models: [...new Set(names)] }];
		});
	}

	// The models of mlsem.llm.anthropic in the order given: names, or
	// { model, effort } objects. Unknown efforts are dropped, as are empty
	// names and repeated entries.
	get llmAnthropicModels(): AnthropicModel[] {
		const setting = this.cfg.get<unknown>("llm.anthropic");
		const models =
			typeof setting === "object" && setting !== null ? (setting as { models?: unknown }).models : undefined;
		if (!Array.isArray(models)) return [];
		const parsed = models.flatMap((m): AnthropicModel[] => {
			if (typeof m === "string") return m.trim() === "" ? [] : [{ model: m }];
			if (typeof m !== "object" || m === null) return [];
			const { model, effort } = m as { model?: unknown; effort?: unknown };
			if (typeof model !== "string" || model.trim() === "") return [];
			return [EFFORTS.includes(effort as Effort) ? { model, effort: effort as Effort } : { model }];
		});
		return parsed.filter((m, i) => parsed.findIndex((n) => n.model === m.model && n.effort === m.effort) === i);
	}

	get llmMaxTries(): number {
		return Math.max(1, this.cfg.get<number>("llm.maxTries") ?? 5);
	}

	get llmTimeoutCountsAsFail(): boolean {
		return this.cfg.get<boolean>("llm.timeoutCountsAsFail") ?? true;
	}

	setLlmTimeoutCountsAsFail(value: boolean) {
		return this.cfg.update("llm.timeoutCountsAsFail", value, vscode.ConfigurationTarget.Global);
	}

	get serverPath(): string | null {
		// biome-ignore lint/style/noNonNullAssertion: Keep in sync with package.json.
		return this.cfg.get<string | null>("server.path")!;
	}
}
