import { once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionRequest } from "../src/ai/protocol";
import { createInitialState } from "../src/engine/engine";
import { buildBoard, getMap } from "../src/engine/maps";
import { DEFAULT_RULES } from "../src/engine/rules";
import { buildSnapshot } from "../src/engine/snapshot";
import type { GenerateRequest } from "./providers/types";

const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

const board = buildBoard(getMap("foundry"));
const state = createInitialState(board, DEFAULT_RULES, "A");
const snapshot = buildSnapshot(board, DEFAULT_RULES, state, []);
const firstMove = snapshot.moves[0].to;
const firstKey = `move_${firstMove[0]}_${firstMove[1]}`;

interface Call {
  url: string;
  auth?: string;
  body?: Record<string, unknown>;
}

/** Stands in for openrouter.ai. `decisions` lists the ids the catalogue reports as decisions models. */
function stubOpenRouter(decisions: string[], answer: (url: string) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const models = (ids: string[]) => ({ status: 200, body: { data: ids.map((id) => ({ id, name: `Name of ${id}`, pricing: { prompt: "0.000001", completion: "0.000002" } })) } });
    const reply = url.includes("output_modalities=decisions") ? models(decisions) : url.endsWith("/models") ? models(["openai/gpt-4o-mini"]) : answer(url);
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  return calls;
}

// The model catalogue is cached per module, so each test loads fresh copies.
async function load() {
  vi.resetModules();
  const [{ createOpenRouterProvider }, { getOpenRouterCatalog }] = await Promise.all([import("./providers/openrouter"), import("./openRouterCatalog")]);
  return { createOpenRouterProvider, getOpenRouterCatalog };
}

const generate = (patch: Partial<GenerateRequest> = {}): GenerateRequest => ({
  system: "s",
  prompt: "p",
  model: "openai/gpt-4o-mini",
  signal: new AbortController().signal,
  attempt: 0,
  context: { board, rules: DEFAULT_RULES, state, snapshot, seed: 1 },
  ...patch,
});

const chatReply = { status: 200, body: { choices: [{ message: { content: '{"action":"brace"}' } }] } };

afterEach(() => vi.unstubAllGlobals());

describe("OpenRouter provider", () => {
  it("uses the browser's key before the server's, and the server's when the browser has none", async () => {
    const calls = stubOpenRouter([], () => chatReply);
    const provider = (await load()).createOpenRouterProvider("sk-server");
    await expect(provider.generate(generate({ openRouterKey: "sk-browser" }))).resolves.toBe('{"action":"brace"}');
    await provider.generate(generate());
    const chats = calls.filter((c) => c.url === CHAT_URL);
    expect(chats.map((c) => c.auth)).toEqual(["Bearer sk-browser", "Bearer sk-server"]);
    expect(chats[0].body).toMatchObject({ model: "openai/gpt-4o-mini", temperature: 0.3 });
  });

  it("asks for a key in Settings when there is none", async () => {
    const calls = stubOpenRouter([], () => chatReply);
    const provider = (await load()).createOpenRouterProvider(undefined);
    await expect(provider.generate(generate())).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/Settings/) });
    expect(calls).toHaveLength(0);
    expect(await provider.status()).toMatchObject({ ready: false, defaultModel: "openai/gpt-4o-mini" });
  });

  it("sends a decisions model the legal actions as choices and returns its pick as an action", async () => {
    const calls = stubOpenRouter(["vendor/pick-decisions"], () => ({ status: 200, body: { answers: { action: { type: "choice", choice: firstKey, probabilities: { [firstKey]: 0.7, brace: 0.2 } } } } }));
    const provider = (await load()).createOpenRouterProvider("sk-server");
    const reply = JSON.parse(await provider.generate(generate({ model: "vendor/pick-decisions" })));
    expect(reply).toEqual({ action: "move", to: firstMove, explanation: `Decisions model: chose move to [${firstMove}] with 70% probability, next best brace 20%.` });
    const sent = calls.find((c) => c.url === DECISIONS_URL)!.body as { questions: { action: { criteria: Record<string, string> } } };
    expect(Object.keys(sent.questions.action.criteria)).toEqual(expect.arrayContaining([firstKey, "brace"]));
    expect(Object.keys(sent.questions.action.criteria).every((key) => /^\w+$/.test(key))).toBe(true);
    expect(calls.some((c) => c.url === CHAT_URL)).toBe(false);
  });

  it("falls back to the decisions endpoint when chat rejects an uncatalogued decisions model", async () => {
    const calls = stubOpenRouter([], (url) =>
      url === CHAT_URL
        ? { status: 400, body: { error: { message: "vendor/new is a decisions model and cannot be used with the chat/completions endpoint." } } }
        : { status: 200, body: { answers: { action: { type: "choice", choice: "brace" } } } },
    );
    const provider = (await load()).createOpenRouterProvider("sk-server");
    expect(JSON.parse(await provider.generate(generate({ model: "vendor/new" })))).toMatchObject({ action: "brace" });
    expect(calls.map((c) => c.url).filter((u) => !u.includes("/models"))).toEqual([CHAT_URL, DECISIONS_URL]);
  });

  it.each([
    [{ type: "refusal" }, /refused/],
    [{ type: "choice", choice: "teleport" }, /not one of the legal actions/],
  ])("reports an unusable decisions answer as retryable", async (answer, message) => {
    stubOpenRouter(["vendor/pick-decisions"], () => ({ status: 200, body: { answers: { action: answer } } }));
    const provider = (await load()).createOpenRouterProvider("sk-server");
    await expect(provider.generate(generate({ model: "vendor/pick-decisions" }))).rejects.toMatchObject({ retryable: true, message: expect.stringMatching(message) });
  });

  it("lists chat and decisions models with prices, fetching the catalogue once", async () => {
    const calls = stubOpenRouter(["vendor/pick-decisions"], () => chatReply);
    const { getOpenRouterCatalog } = await load();
    const { models } = await getOpenRouterCatalog();
    await getOpenRouterCatalog();
    expect(models).toEqual([
      { id: "openai/gpt-4o-mini", label: "Name of openai/gpt-4o-mini", hint: "$1.00 / $2.00 per 1M" },
      { id: "vendor/pick-decisions", label: "Name of vendor/pick-decisions", hint: "Decisions · $1.00 per 1M in" },
    ]);
    expect(calls).toHaveLength(2);
  });
});

describe("browser key on /api/decide", () => {
  let server: Server | null = null;
  afterEach(() => server?.close());

  const body: DecisionRequest = {
    matchId: "match-key-1",
    epoch: 1,
    turn: 1,
    side: "A",
    mapId: "foundry",
    swapStarts: false,
    rules: DEFAULT_RULES,
    state,
    history: [],
    player: { provider: "openrouter", model: "openai/gpt-4o-mini" },
    settings: { retries: 0, timeoutMs: 10_000 },
    seed: 1,
  };

  it("accepts OpenRouter's ~latest model aliases", async () => {
    const { parseDecisionRequest } = await import("./decide");
    expect(parseDecisionRequest({ ...body, player: { provider: "openrouter", model: "~vendor/model-latest" } }).ok).toBe(true);
    expect(parseDecisionRequest({ ...body, player: { provider: "openrouter", model: "vendor/model; rm" } }).ok).toBe(false);
  });

  it("is validated, forwarded to OpenRouter, and kept out of the reply and the log", async () => {
    const calls = stubOpenRouter([], () => ({ status: 401, body: { error: { message: "No auth credentials found" } } }));
    vi.resetModules();
    const [{ createApi }, { createRegistry }] = await Promise.all([import("./app"), import("./providers/registry")]);
    const logs: string[] = [];
    const api = createApi({ registry: createRegistry({}, { mockLatencyMs: 0 }), log: (line) => logs.push(line), backoffMs: 0 });
    server = createServer((req, res) => api(req, res, () => res.writeHead(404).end()));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    // fetch is stubbed to play openrouter.ai, so the test calls the local API with node:http.
    const post = (payload: unknown) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: "/api/decide", method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode!, text }));
        });
        req.on("error", reject);
        req.end(JSON.stringify(payload));
      });

    const bad = await post({ ...body, openRouterKey: "two words" });
    expect(bad).toMatchObject({ status: 400, text: expect.stringMatching(/invalid OpenRouter key/) });
    expect(bad.text).not.toContain("two words");

    const rejected = await post({ ...body, openRouterKey: "sk-or-very-secret" });
    expect(rejected.status).toBe(502);
    expect(rejected.text).toMatch(/rejected the API key/);
    expect(rejected.text).not.toContain("very-secret");
    expect(logs.join("\n")).not.toContain("very-secret");
    expect(calls.find((c) => c.url === CHAT_URL)?.auth).toBe("Bearer sk-or-very-secret");
  });
});
