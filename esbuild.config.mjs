import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");
const isMinify = process.argv.includes("--minify");

/** @type {esbuild.BuildOptions[]} */
const configs = [
	{
		entryPoints: ["src/extension.ts"],
		bundle: true,
		outfile: "dist/extension.js",
		external: ["vscode"],
		format: "cjs",
		platform: "node",
		target: "node22",
		sourcemap: !isMinify,
		minify: isMinify,
	},
	{
		entryPoints: ["src/webview/index.tsx"],
		bundle: true,
		outfile: "dist/webview.js",
		format: "iife",
		platform: "browser",
		target: "es2022",
		sourcemap: !isMinify,
		minify: isMinify,
	},
];

if (isWatch) {
	const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
	await Promise.all(contexts.map((ctx) => ctx.watch()));
	console.log("Watching for changes...");
} else {
	await Promise.all(configs.map((c) => esbuild.build(c)));
}
