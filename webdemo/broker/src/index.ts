import { randomUUID } from "node:crypto";
import http from "node:http";
import Docker from "dockerode";
import express from "express";
import httpProxy from "http-proxy-3";
import morgan from "morgan";

const PORT = Number(process.env.PORT ?? "8080");
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS ?? "7200");
const SESSION_IMAGE = process.env.SESSION_IMAGE ?? "vscode-demo-code-server:latest";
const SESSION_NETWORK = process.env.SESSION_NETWORK ?? "vscode-demo-net";
const SESSION_CONTAINER_PREFIX = process.env.SESSION_CONTAINER_PREFIX ?? "vscode-demo-session";
const CODE_SERVER_PORT = Number(process.env.CODE_SERVER_PORT ?? "8080");

// URL path prefix the broker is served under (e.g. "/webdemo"), configurable
// per deployment. The upstream reverse proxy must PRESERVE this prefix (forward
// it as-is, not strip it).
const BASE_PATH = normalizeBasePath(process.env.BASE_PATH ?? "/webdemo");

function normalizeBasePath(raw: string): string {
	return `/${raw.trim().replace(/^\/+|\/+$/g, "")}`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const app = express();

const proxy = httpProxy.createProxyServer({
	ws: true,
	// Do NOT rewrite Host: code-server rejects WebSocket upgrades whose Origin
	// host does not match the Host header (anti-CSRF). changeOrigin would set
	// Host to the container name while the browser's Origin stays the public
	// host, causing a 403 / 1006 close. Preserving the original Host keeps them
	// matched; the connection still targets the session container regardless.
	xfwd: true,
});

app.use(morgan("combined"));

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function getContainerName(sessionId: string): string {
	return `${SESSION_CONTAINER_PREFIX}-${sessionId}`;
}

function getTarget(sessionId: string): string {
	return `http://${getContainerName(sessionId)}:${CODE_SERVER_PORT}`;
}

function getExpiryDate(): Date {
	return new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
}

async function createSessionContainer(sessionId: string): Promise<void> {
	const containerName = getContainerName(sessionId);
	const expiresAt = getExpiryDate().toISOString();

	const container = await docker.createContainer({
		Image: SESSION_IMAGE,
		name: containerName,
		Labels: {
			"vscode-demo.managed": "true",
			"vscode-demo.session-id": sessionId,
			"vscode-demo.expires-at": expiresAt,
		},
		HostConfig: {
			NetworkMode: SESSION_NETWORK,
			Memory: 1024 * 1024 * 1024,
			NanoCpus: 1_000_000_000,
			PidsLimit: 512,
			SecurityOpt: ["no-new-privileges"],
			CapDrop: ["ALL"],
			AutoRemove: false,
		},
		Env: [`SESSION_ID=${sessionId}`],
	});

	await container.start();
}

async function sessionExists(sessionId: string): Promise<boolean> {
	const name = getContainerName(sessionId);

	try {
		const container = docker.getContainer(name);
		const info = await container.inspect();
		return info.State?.Running === true;
	} catch {
		return false;
	}
}

// code-server's /healthz responds 200 only once its HTTP server is listening.
// We probe it from the broker over the internal network so we redirect the
// browser to the session only after proxying will actually succeed (no 502).
async function isCodeServerReady(sessionId: string): Promise<boolean> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 2000);

	try {
		const res = await fetch(`${getTarget(sessionId)}/healthz`, {
			signal: controller.signal,
		});
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

function renderLoadingPage(sessionId: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Preparing your workspace…</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #1e1e1e;
    color: #cccccc;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .card { text-align: center; padding: 2rem; }
  .spinner {
    width: 48px;
    height: 48px;
    margin: 0 auto 1.5rem;
    border: 4px solid #3c3c3c;
    border-top-color: #0e639c;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { font-size: 1.1rem; font-weight: 500; margin: 0 0 0.5rem; }
  p { font-size: 0.85rem; color: #8c8c8c; margin: 0; }
  .error { color: #f48771; }
  a { color: #4daafc; }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation-duration: 3s; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="spinner" id="spinner"></div>
    <h1 id="title">Preparing your workspace…</h1>
    <p id="status">Starting a fresh container. This usually takes a few seconds.</p>
  </div>
  <script>
    const sessionId = ${JSON.stringify(sessionId)};
    const basePath = ${JSON.stringify(BASE_PATH)};
    const target = basePath + "/s/" + sessionId + "/";
    const deadline = Date.now() + 90000;

    async function poll() {
      if (Date.now() > deadline) {
        document.getElementById("spinner").style.display = "none";
        document.getElementById("title").textContent = "Taking longer than expected";
        const status = document.getElementById("status");
        status.className = "error";
        status.innerHTML = 'Your workspace did not become ready in time. <a href="' + basePath + '/">Try again</a>.';
        return;
      }
      try {
        const res = await fetch(basePath + "/api/ready/" + sessionId, { cache: "no-store" });
        const data = await res.json();
        if (data.ready) {
          window.location.replace(target);
          return;
        }
      } catch (_) { /* keep polling */ }
      setTimeout(poll, 750);
    }
    poll();
  </script>
</body>
</html>`;
}

// All routes live on a router mounted at BASE_PATH, so the whole broker can be
// served under a sub-path (e.g. /webdemo) with the prefix stripped uniformly.
const router = express.Router();

router.get("/health", (_req, res) => {
	res.json({ ok: true });
});

router.get("/", async (_req, res, next) => {
	try {
		const sessionId = randomUUID();

		await createSessionContainer(sessionId);

		// Serve a loading page instead of redirecting immediately: the container is
		// running but code-server needs a moment to start listening. The page polls
		// /api/ready and redirects to the session only once it responds.
		res.type("html").send(renderLoadingPage(sessionId));
	} catch (error) {
		next(error);
	}
});

router.get("/api/ready/:sessionId", async (req, res) => {
	const sessionId = req.params.sessionId;

	if (!isUuid(sessionId)) {
		res.status(404).json({ ready: false });
		return;
	}

	const running = await sessionExists(sessionId);
	const ready = running ? await isCodeServerReady(sessionId) : false;
	res.json({ ready });
});

router.use("/s/:sessionId", async (req, res, next) => {
	const sessionId = req.params.sessionId;

	if (!isUuid(sessionId)) {
		res.status(404).send("Session not found");
		return;
	}

	try {
		const exists = await sessionExists(sessionId);

		if (!exists) {
			res.status(404).send("Session expired or not found");
			return;
		}

		const target = getTarget(sessionId);

		proxy.web(req, res, {
			target,
			ignorePath: false,
		});
	} catch (error) {
		next(error);
	}
});

// Mounting at BASE_PATH strips the prefix from req.url, so downstream handlers
// and the code-server proxy see paths without the deployment prefix.
app.use(BASE_PATH, router);

proxy.on("error", (error, _req, res) => {
	console.error("Proxy error:", error);

	// `res` is a ServerResponse for proxy.web errors, but a Socket for proxy.ws
	// errors. Only ServerResponse has writeHead/headersSent.
	if (res && "writeHead" in res) {
		if (!res.headersSent) {
			res.writeHead(502, { "Content-Type": "text/plain" });
		}
		res.end("Bad gateway");
	} else if (res) {
		res.destroy();
	}
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
	console.error(error);
	res.status(500).send("Internal server error");
});

async function cleanupExpiredSessions(): Promise<void> {
	const containers = await docker.listContainers({
		all: true,
		filters: {
			label: ["vscode-demo.managed=true"],
		},
	});

	const now = Date.now();

	for (const summary of containers) {
		const expiresAt = summary.Labels?.["vscode-demo.expires-at"];

		if (!expiresAt) {
			continue;
		}

		const expiresAtTime = Date.parse(expiresAt);

		if (Number.isNaN(expiresAtTime) || expiresAtTime > now) {
			continue;
		}

		try {
			const container = docker.getContainer(summary.Id);
			await container.remove({ force: true });
			console.log(`Removed expired session container ${summary.Id}`);
		} catch (error) {
			console.error(`Failed to remove expired container ${summary.Id}`, error);
		}
	}
}

setInterval(() => {
	cleanupExpiredSessions().catch((error) => {
		console.error("Cleanup failed:", error);
	});
}, 60_000);

const server = http.createServer(app);

server.on("upgrade", async (req, socket, head) => {
	try {
		const url = new URL(req.url ?? "", `http://${req.headers.host}`);
		const match = url.pathname.match(new RegExp(`^${escapeRegExp(BASE_PATH)}/s/([^/]+)`));

		if (!match) {
			socket.destroy();
			return;
		}

		const sessionId = match[1];

		if (!isUuid(sessionId)) {
			socket.destroy();
			return;
		}

		const exists = await sessionExists(sessionId);

		if (!exists) {
			socket.destroy();
			return;
		}

		// Strip BASE_PATH so code-server receives the same WS path it would
		// without a prefix (the HTTP router mount strips it equivalently).
		if (req.url) {
			req.url = req.url.slice(BASE_PATH.length) || "/";
		}

		proxy.ws(req, socket, head, {
			target: getTarget(sessionId),
		});
	} catch (error) {
		console.error("WebSocket upgrade failed:", error);
		socket.destroy();
	}
});

server.listen(PORT, () => {
	console.log(`Broker listening on port ${PORT} (base path ${BASE_PATH})`);
});
