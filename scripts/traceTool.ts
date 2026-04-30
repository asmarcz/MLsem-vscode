#!/usr/bin/env -S bun run
import { createReadStream } from "node:fs";
import { watch } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

// ─── CLI ──────────────────────────────────────────────────────────────────────

const usage = `Usage: traceTool.ts [options] <file>

Watch a file, parse LSP trace entries, and emit them as JSON lines.

Options:
  -m, --method <pat>    Only emit entries whose method contains <pat> as a
                        substring (repeatable; comma-separated also accepted)
  -s, --since <time>    Only emit entries at or after this time;
                        accepts "now" (default), "all" (no cutoff), or
                        "HH:MM:SS [AM|PM]"
  -p, --pretty          Pretty-print the JSON body
  -b, --brief           Print just "[time]  [method]" per entry (no JSON)
  -h, --help            Show this help

Examples:
  Method filter (-m, --method):
    traceTool.ts -m inlay trace.log              # one substring
    traceTool.ts -m inlay -m hover trace.log     # repeated flag
    traceTool.ts -m inlay,hover trace.log        # comma-separated

  Time cutoff (-s, --since):
    traceTool.ts trace.log                       # default: --since now
    traceTool.ts --since all trace.log           # no cutoff
    traceTool.ts --since "10:30:00 AM" trace.log # explicit time
    traceTool.ts --since "11:55:00 PM" trace.log # shifted to yesterday
                                                 # if past current time`;

function parseCli() {
	try {
		return parseArgs({
			allowPositionals: true,
			args: Bun.argv.slice(2),
			options: {
				help: { type: "boolean", short: "h" },
				method: { type: "string", short: "m", multiple: true },
				since: { type: "string", short: "s", default: "now" },
				pretty: { type: "boolean", short: "p" },
				brief: { type: "boolean", short: "b" },
			},
		});
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		console.error(usage);
		process.exit(2);
	}
}

const { values, positionals } = parseCli();

if (values.help || positionals.length === 0) {
	console.log(usage);
	process.exit(values.help ? 0 : 1);
}

const path = positionals[0];
const methodFilter =
	values.method
		?.flatMap((m) => m.split(","))
		.filter(Boolean)
		.map((m) => m.toLowerCase()) ?? null;
const sinceSeconds = values.since === "all" ? null : parseTimeArg(values.since ?? "now");

function parseTimeArg(s: string): number {
	const now = nowSeconds();
	if (s === "now") return now;
	const t = timeToSeconds(s);
	return t > now ? t - 86400 : t;
}

function nowSeconds(): number {
	const d = new Date();
	return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

function timeToSeconds(t: string): number {
	const m = /^(\d+):(\d+):(\d+)(?:\s+(AM|PM))?$/i.exec(t);
	if (!m) throw new Error(`bad time: ${t}`);
	let h = Number(m[1]);
	const meridiem = m[4]?.toUpperCase();
	if (meridiem === "PM" && h !== 12) h += 12;
	else if (meridiem === "AM" && h === 12) h = 0;
	return h * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// ─── Parser ───────────────────────────────────────────────────────────────────

const HEADER: RegExp = /^\[Trace - (\S+ \S+)\] (Sending|Received) (\S+) '([^']+?)(?: - \((\d+)\))?'(?: in (\d+)ms)?\.$/;

type Entry = {
	time: string;
	direction: "Sending" | "Received";
	kind: string;
	method: string;
	id?: number;
	durationMs?: number;
	bodyKind?: "Params" | "Result" | "Error";
	body?: unknown;
};

let current: Entry | null = null;
let bodyLines: string[] = [];

function format(entry: Entry): string {
	if (values.brief) return `${entry.time}  ${entry.method}`;
	return JSON.stringify(entry, null, values.pretty ? 2 : undefined);
}

function flush() {
	const entry = current;
	if (!entry) return;
	if (bodyLines.length > 0) entry.body = JSON.parse(bodyLines.join("\n"));
	const keep =
		(!methodFilter || methodFilter.some((p) => entry.method.toLowerCase().includes(p))) &&
		(sinceSeconds === null || timeToSeconds(entry.time) >= sinceSeconds);
	if (keep) console.log(format(entry));
	current = null;
	bodyLines = [];
}

function feed(line: string) {
	const h = HEADER.exec(line);
	if (h) {
		flush();
		current = {
			time: h[1],
			direction: h[2] as "Sending" | "Received",
			kind: h[3],
			method: h[4],
			...(h[5] && { id: Number(h[5]) }),
			...(h[6] && { durationMs: Number(h[6]) }),
		};
		return;
	}
	if (!current) return;
	const label = /^(Params|Result|Error): (.*)$/.exec(line);
	if (label) {
		current.bodyKind = label[1] as Entry["bodyKind"];
		bodyLines = [label[2]];
		return;
	}
	if (line === "") {
		flush();
		return;
	}
	if (current.bodyKind) bodyLines.push(line);
}

// ─── Watcher ──────────────────────────────────────────────────────────────────

let offset = 0;

async function drain() {
	const size = Bun.file(path).size;
	if (size < offset) offset = 0;
	if (size === offset) return;

	const stream = createReadStream(path, { start: offset, end: size - 1 });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	for await (const line of rl) feed(line);
	offset = size;
}

await drain();
for await (const event of watch(path)) {
	if (event.eventType === "change") await drain();
}
