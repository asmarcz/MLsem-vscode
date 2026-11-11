import * as vscode from "vscode";

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

	get llmBaseUrl(): string {
		return this.cfg.get<string>("llm.baseUrl") || "https://api.openai.com/v1";
	}

	get llmModel(): string {
		return this.cfg.get<string>("llm.model") ?? "";
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
