#!/usr/bin/env -S bun run
import { createReadStream } from "node:fs";
import { watch } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

// ─── CLI ──────────────────────────────────────────────────────────────────────

const usage = `Usage: traceTool.ts [options] <file>

Watch a file and print new lines as they are appended.

Options:
  -h, --help   Show this help`;

let values: { help?: boolean };
let positionals: string[];
try {
	({ values, positionals } = parseArgs({
		allowPositionals: true,
		args: Bun.argv.slice(2),
		options: {
			help: { type: "boolean", short: "h" },
		},
	}));
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err));
	console.error(usage);
	process.exit(2);
}

if (values.help || positionals.length === 0) {
	console.log(usage);
	process.exit(values.help ? 0 : 1);
}

const path = positionals[0];

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

function flush() {
	if (!current) return;
	if (bodyLines.length > 0) current.body = JSON.parse(bodyLines.join("\n"));
	console.log(JSON.stringify(current));
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
