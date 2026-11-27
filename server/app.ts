import type { IncomingMessage, ServerResponse } from "node:http";
import { CancelledError, decide, DecisionGate, parseDecisionRequest } from "./decide";
import { getOpenRouterCatalog } from "./openRouterCatalog";
import { providerInfos } from "./providers/registry";
import type { ProviderAdapter } from "./providers/types";

const MAX_BODY_BYTES = 1_000_000;

export interface ApiOptions {
  registry: Map<string, ProviderAdapter>;
  log?: (line: string) => void;
  backoffMs?: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * /api/decide spends the user's provider quota, so it only accepts JSON from this app's own pages:
 * requiring application/json forces a CORS preflight for cross-site callers, and the Origin check rejects the rest.
 */
function isTrustedJson(req: IncomingMessage): boolean {
  if (!req.headers["content-type"]?.startsWith("application/json")) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Returns a request handler for /api/*; anything else is passed to `next`. */
export function createApi({ registry, log = () => {}, backoffMs }: ApiOptions) {
  const gate = new DecisionGate();

  return async function handle(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    if (!url.pathname.startsWith("/api/")) return next();

    if (req.method === "GET" && url.pathname === "/api/health") return sendJson(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/api/providers") return sendJson(res, 200, { providers: await providerInfos(registry, url.searchParams.has("fresh")) });

    if (req.method === "GET" && url.pathname === "/api/openrouter/models") {
      try {
        return sendJson(res, 200, { models: (await getOpenRouterCatalog()).models });
      } catch (error) {
        return sendJson(res, 502, { models: [], error: `Could not load OpenRouter models: ${(error as Error).message}` });
      }
    }

    const check = /^\/api\/providers\/([a-z0-9-]+)\/check$/.exec(url.pathname);
    if (req.method === "POST" && check) {
      // Spends a little of the user's quota, so it takes the same same-origin guard as a decision.
      if (!isTrustedJson(req)) return sendJson(res, 403, { ok: false, error: "Only same-origin JSON requests are accepted" });
      const adapter = registry.get(check[1]);
      if (!adapter?.checkModels) return sendJson(res, 404, { ok: false, error: "This provider cannot check its models" });
      try {
        await adapter.checkModels(AbortSignal.timeout(120_000));
      } catch (error) {
        log(`[check] ${adapter.id}: ${(error as Error).message}`);
        return sendJson(res, 502, { ok: false, error: (error as Error).message, providers: await providerInfos(registry) });
      }
      return sendJson(res, 200, { ok: true, providers: await providerInfos(registry) });
    }

    if (req.method === "POST" && url.pathname === "/api/decide") {
      if (!isTrustedJson(req)) return sendJson(res, 403, { ok: false, error: "Only same-origin JSON requests are accepted" });
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { ok: false, error: "Body must be JSON under 1 MB" });
      }
      const parsed = parseDecisionRequest(body);
      if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error });
      const { request, board } = parsed.value;

      const slot = gate.begin(request.matchId, request.epoch, request.turn);
      if (!slot.ok) return sendJson(res, 409, { ok: false, error: slot.error });
      // Closing the tab, pausing with cancel, or a superseding request all abort the provider call.
      const clientGone = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) clientGone.abort();
      });
      const signal = AbortSignal.any([clientGone.signal, slot.controller.signal]);
      try {
        const outcome = await decide(request, board, registry, signal, { backoffMs });
        const tag = `match=${request.matchId.slice(0, 8)} T${request.turn} ${request.side} ${request.player.provider}/${request.player.model}`;
        if (outcome.ok) log(`[decide] ${tag} ${outcome.action.type}${outcome.fallback ? " (fallback)" : ""} ${outcome.durationMs}ms retries=${outcome.attempts.length}`);
        else log(`[decide] ${tag} error: ${outcome.error}`);
        if (!res.writableEnded && !clientGone.signal.aborted) sendJson(res, outcome.ok ? 200 : 502, outcome);
      } catch (error) {
        if (error instanceof CancelledError) {
          if (!res.writableEnded && !res.destroyed) sendJson(res, 499, { ok: false, error: "cancelled" });
        } else {
          log(`[decide] unexpected error: ${(error as Error).stack ?? error}`);
          if (!res.writableEnded) sendJson(res, 500, { ok: false, error: "Internal error while deciding" });
        }
      } finally {
        slot.release();
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  };
}
