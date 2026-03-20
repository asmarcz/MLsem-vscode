import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");
const isMinify = process.argv.includes("--minify");

/** @type {esbuild.BuildOptions} */
const config = {
	entryPoints: ["src/extension.ts"],
	bundle: true,
	outfile: "dist/extension.js",
	external: ["vscode"],
	format: "cjs",
	platform: "node",
	target: "node22",
	sourcemap: !isMinify,
	minify: isMinify,
};

if (isWatch) {
	const ctx = await esbuild.context(config);
	await ctx.watch();
	console.log("Watching for changes...");
} else {
	await esbuild.build(config);
}
