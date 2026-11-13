// The active colour theme's style for each scope of the MLsem grammar, for
// highlighting in the type toolkit as in the editor.
//
// VS Code gives webviews the theme's UI colours but not its token colours,
// so they are read here: the active theme's file is found among the
// installed extensions (built-in ones included), its [include] chain
// followed, the user's [editor.tokenColorCustomizations] applied, and each
// scope resolved with TextMate's rules (the most specific selector wins,
// a later rule on a tie).

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { TokenStyle } from "./protocol";

interface ThemeRule {
	scope?: string | string[];
	settings?: { foreground?: string; fontStyle?: string };
}

// JSON with comments and trailing commas, as theme files are written.
function parseJsonc(text: string): unknown {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (c === "/" && text[i + 1] === "*") {
			i = text.indexOf("*/", i + 2);
			i = i < 0 ? text.length : i + 2;
		} else {
			out += c;
			i++;
		}
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// The token rules of the theme file at [file], those it includes first.
function themeRules(file: string, depth = 0): ThemeRule[] {
	if (depth > 10) return [];
	let json: { include?: string; tokenColors?: ThemeRule[] | string };
	try {
		json = parseJsonc(fs.readFileSync(file, "utf8")) as typeof json;
	} catch {
		return [];
	}
	const included = json.include ? themeRules(path.resolve(path.dirname(file), json.include), depth + 1) : [];
	// A [tokenColors] given as a path to a .tmTheme file is not read.
	const own = Array.isArray(json.tokenColors) ? json.tokenColors : [];
	return [...included, ...own];
}

// The name of the active theme, as in the settings.
function activeThemeName(): string {
	const workbench = vscode.workspace.getConfiguration("workbench");
	const window = vscode.workspace.getConfiguration("window");
	const kind = vscode.window.activeColorTheme.kind;
	const highContrast = kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight;
	const dark = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
	if (highContrast && window.get<boolean>("autoDetectHighContrast")) {
		const name = workbench.get<string>(
			dark ? "preferredHighContrastColorTheme" : "preferredHighContrastLightColorTheme",
		);
		if (name) return name;
	}
	if (window.get<boolean>("autoDetectColorScheme")) {
		const name = workbench.get<string>(dark ? "preferredDarkColorTheme" : "preferredLightColorTheme");
		if (name) return name;
	}
	return workbench.get<string>("colorTheme") ?? (dark ? "Default Dark Modern" : "Default Light Modern");
}

// The file of the theme named [name], among the installed extensions.
// Built-in themes are named in the settings with a "Default " prefix
// ("Default Dark Modern" for the theme of id "Dark Modern"), and a label can
// be a "%key%" of the extension's package.nls.json.
function themeFile(name: string): string | undefined {
	const names = [name, name.replace(/^Default /, "")];
	for (const ext of vscode.extensions.all) {
		const themes: { id?: string; label?: string; path: string }[] = ext.packageJSON?.contributes?.themes ?? [];
		if (themes.length === 0) continue;
		let nls: Record<string, string> = {};
		try {
			nls = JSON.parse(fs.readFileSync(path.join(ext.extensionPath, "package.nls.json"), "utf8"));
		} catch {
			// No localized labels.
		}
		const label = (l?: string) => (l?.startsWith("%") && l.endsWith("%") ? nls[l.slice(1, -1)] : l);
		const theme = themes.find((t) => names.includes(t.id ?? "") || names.includes(label(t.label) ?? ""));
		if (theme) return path.join(ext.extensionPath, theme.path);
	}
	return undefined;
}

// The settings shortcuts of [editor.tokenColorCustomizations], as scopes.
const SHORTCUTS: Record<string, string[]> = {
	comments: ["comment"],
	strings: ["string"],
	keywords: ["keyword"],
	numbers: ["constant.numeric"],
	types: ["entity.name.type", "entity.name.class", "support.type", "support.class"],
	functions: ["entity.name.function", "support.function"],
	variables: ["variable", "entity.name.variable"],
};

// The rules of a [tokenColorCustomizations] object.
function customRules(custom: Record<string, unknown> | undefined): ThemeRule[] {
	if (!custom) return [];
	const rules: ThemeRule[] = [];
	for (const [key, scopes] of Object.entries(SHORTCUTS)) {
		const v = custom[key];
		if (typeof v === "string") rules.push({ scope: scopes, settings: { foreground: v } });
		else if (v && typeof v === "object") rules.push({ scope: scopes, settings: v as ThemeRule["settings"] });
	}
	const tm = custom.textMateRules;
	if (Array.isArray(tm)) rules.push(...(tm as ThemeRule[]));
	return rules;
}

// How specific [selector] is for a token of scope [scope] inside the file's
// scope [root], or -1 if it does not apply. A selector is a space-separated
// path of scope prefixes, the last for the token; an exclusion (" - ") is
// not supported and counts as not applying.
function specificity(selector: string, scope: string, root: string): number {
	if (selector.includes(" - ")) return -1;
	const parts = selector.trim().split(/\s+/);
	const last = parts.pop();
	if (!last) return -1;
	const prefixOf = (p: string, s: string) => s === p || s.startsWith(`${p}.`);
	if (!prefixOf(last, scope)) return -1;
	if (parts.some((p) => !prefixOf(p, root))) return -1;
	return last.split(".").length * 10 + parts.length;
}

// The style the rules give [scope]: per property, from the most specific
// selector, a later rule winning a tie.
function resolve(rules: ThemeRule[], scope: string, root: string): TokenStyle {
	const best: Record<"foreground" | "fontStyle", { score: number; value?: string }> = {
		foreground: { score: -1 },
		fontStyle: { score: -1 },
	};
	for (const rule of rules) {
		if (!rule.scope || !rule.settings) continue;
		const selectors = Array.isArray(rule.scope) ? rule.scope : rule.scope.split(",");
		const score = Math.max(...selectors.map((s) => specificity(s, scope, root)));
		if (score < 0) continue;
		for (const key of ["foreground", "fontStyle"] as const) {
			const value = rule.settings[key];
			if (value !== undefined && score >= best[key].score) best[key] = { score, value };
		}
	}
	return { foreground: best.foreground.value, fontStyle: best.fontStyle.value };
}

// The scopes the grammar at [file] can give.
function grammarScopes(file: string): string[] {
	const scopes = new Set<string>();
	const walk = (node: unknown) => {
		if (Array.isArray(node)) node.forEach(walk);
		else if (node && typeof node === "object") {
			for (const [k, v] of Object.entries(node)) {
				if (k === "name" && typeof v === "string") scopes.add(v);
				else walk(v);
			}
		}
	};
	walk(JSON.parse(fs.readFileSync(file, "utf8")));
	return [...scopes];
}

// The active theme's style for each scope of the MLsem grammar.
export function tokenColors(extensionPath: string): Record<string, TokenStyle> {
	const name = activeThemeName();
	const file = themeFile(name);
	const editor = vscode.workspace.getConfiguration("editor");
	const custom = editor.get<Record<string, unknown>>("tokenColorCustomizations");
	const rules = [
		...(file ? themeRules(file) : []),
		...customRules(custom),
		...customRules(custom?.[`[${name}]`] as Record<string, unknown> | undefined),
	];
	const colors: Record<string, TokenStyle> = {};
	for (const scope of grammarScopes(path.join(extensionPath, "syntaxes", "mlsem.tmLanguage.json"))) {
		const style = resolve(rules, scope, "source.mlsem");
		if (style.foreground || style.fontStyle) colors[scope] = style;
	}
	return colors;
}
