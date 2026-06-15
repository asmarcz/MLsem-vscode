// CSS files are imported as raw text (esbuild's "text" loader) and injected
// into the webview via a <style> element.
declare module "*.css" {
	const content: string;
	export default content;
}
