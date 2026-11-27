import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "./app";
import { createRegistry } from "./providers/registry";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  /* .env is optional: mock models need nothing */
}

const dev = process.argv.includes("--dev");
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

const registry = createRegistry(process.env);
const api = createApi({ registry, log: (line) => console.log(line) });

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
};

function serveStatic(dist: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://local").pathname);
    let file = path.normalize(path.join(dist, pathname));
    if (!file.startsWith(dist)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, "index.html");
    const ext = path.extname(file);
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(file).pipe(res);
  };
}

async function main() {
  let fallback: (req: IncomingMessage, res: ServerResponse) => void;
  if (dev) {
    const { createServer: createVite } = await import("vite");
    const vite = await createVite({ configFile: path.join(root, "vite.config.ts"), server: { middlewareMode: true }, appType: "spa" });
    fallback = (req, res) => vite.middlewares(req, res);
  } else {
    const dist = path.join(root, "dist");
    if (!existsSync(path.join(dist, "index.html"))) {
      console.error("No production build found. Run `npm run build` first, or `npm run dev` for development.");
      process.exit(1);
    }
    fallback = serveStatic(dist);
  }

  const server = createServer((req, res) => {
    api(req, res, () => fallback(req, res)).catch((error) => {
      console.error(error);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  server.listen(port, host, () => {
    console.log(`Uplink Duel running at http://${host === "0.0.0.0" ? "localhost" : host}:${port} (${dev ? "development" : "production"})`);
    const configured = [...registry.keys()].filter((id) => id !== "mock").join(", ");
    console.log(`Providers registered: mock (always ready), ${configured}. Server keys are read from .env; an OpenRouter key can also be added in the app's Settings.`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
