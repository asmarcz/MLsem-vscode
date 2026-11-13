// MLsem syntax highlighting in the panel, as in the editor.
//
// The tokenizer runs the patterns of the extension's own TextMate grammar,
// in its order, with TextMate's rule: at each position, the pattern matching
// earliest wins, and among those the first listed. So each piece of text
// gets the scope the editor gives it. The colour of a scope comes from the
// extension, resolved from the active theme (see themeColors.ts).

import { type ComponentChildren, createContext } from "preact";
import { useContext } from "preact/hooks";
import grammar from "../../syntaxes/mlsem.tmLanguage.json";
import type { TokenStyle } from "../protocol";

interface Pattern {
	regex: RegExp;
	// The scope of the whole match, or of each capture group.
	name?: string;
	captures?: Record<string, string>;
}

type Rule = {
	name?: string;
	match?: string;
	begin?: string;
	end?: string;
	captures?: Record<string, { name: string }>;
	patterns?: Rule[];
	include?: string;
};

// The grammar's patterns, flattened in order. A begin/end rule (comments,
// strings) becomes one pattern spanning to its end on the same text, which
// is all the panel shows.
function flatten(rules: Rule[], repository: Record<string, Rule>): Pattern[] {
	return rules.flatMap((rule): Pattern[] => {
		if (rule.include?.startsWith("#")) {
			const target = repository[rule.include.slice(1)];
			return target ? flatten([target], repository) : [];
		}
		if (rule.match) {
			const captures = rule.captures
				? Object.fromEntries(Object.entries(rule.captures).map(([k, v]) => [k, v.name]))
				: undefined;
			return [{ regex: new RegExp(rule.match, "y"), name: rule.name, captures }];
		}
		if (rule.begin && rule.end) {
			// Everything up to the end pattern, or to the end of the text.
			const body = `(?:${rule.begin})[\\s\\S]*?(?:(?:${rule.end})|$)`;
			return [{ regex: new RegExp(body, "y"), name: rule.name }];
		}
		return rule.patterns ? flatten(rule.patterns, repository) : [];
	});
}

const g = grammar as unknown as { patterns: Rule[]; repository: Record<string, Rule> };
const PATTERNS = flatten(g.patterns, g.repository);

export interface Token {
	text: string;
	scope?: string;
}

// [text] split into tokens, each with its scope (none for unmatched text).
export function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let plain = "";
	let at = 0;
	while (at < text.length) {
		let best: { p: Pattern; m: RegExpExecArray } | null = null;
		for (const p of PATTERNS) {
			p.regex.lastIndex = at;
			const m = p.regex.exec(text);
			if (m && m[0].length > 0) {
				best = { p, m };
				break;
			}
		}
		if (!best) {
			plain += text[at];
			at++;
			continue;
		}
		if (plain) {
			tokens.push({ text: plain });
			plain = "";
		}
		const { p, m } = best;
		if (p.captures) {
			// Captured groups get their scopes; the rest of the match none.
			let pos = 0;
			for (let i = 1; i < m.length; i++) {
				const part = m[i];
				if (part === undefined) continue;
				const start = m[0].indexOf(part, pos);
				if (start > pos) tokens.push({ text: m[0].slice(pos, start) });
				tokens.push({ text: part, scope: p.captures[String(i)] });
				pos = start + part.length;
			}
			if (pos < m[0].length) tokens.push({ text: m[0].slice(pos) });
		} else {
			tokens.push({ text: m[0], scope: p.name });
		}
		at += m[0].length;
	}
	if (plain) tokens.push({ text: plain });
	return tokens;
}

export function styleOf(colors: Record<string, TokenStyle>, scope?: string) {
	const s = scope ? colors[scope] : undefined;
	if (!s) return undefined;
	return {
		color: s.foreground,
		fontStyle: s.fontStyle?.includes("italic") ? "italic" : undefined,
		fontWeight: s.fontStyle?.includes("bold") ? "bold" : undefined,
		textDecoration: s.fontStyle?.includes("underline") ? "underline" : undefined,
	};
}

// The theme's styles, set once at the root of the panel.
export const TokenColors = createContext<Record<string, TokenStyle>>({});

// [text] highlighted.
export function Code({ text }: { text: string }): ComponentChildren {
	const colors = useContext(TokenColors);
	// Keyed by position: the tokens of a text are positional.
	return tokenize(text).map((t, i) => (
		<span key={i} style={styleOf(colors, t.scope)}>
			{t.text}
		</span>
	));
}
