import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DecisionRequest } from "../src/ai/protocol";
import { createInitialState } from "../src/engine/engine";
import { buildBoard, getMap } from "../src/engine/maps";
import { DEFAULT_RULES } from "../src/engine/rules";
import { createApi } from "./app";
import { CancelledError, decide, DecisionGate, parseDecisionRequest } from "./decide";
import { createRegistry, providerInfos } from "./providers/registry";
import { ProviderError, type GenerateRequest, type ProviderAdapter } from "./providers/types";

const board = buildBoard(getMap("foundry"));

function request(patch: Partial<DecisionRequest> = {}): DecisionRequest {
  const state = createInitialState(board, DEFAULT_RULES, "A");
  return {
    matchId: "test-match",
    epoch: 1,
    turn: state.turn,
    side: state.active,
    mapId: "foundry",
    swapStarts: false,
    rules: DEFAULT_RULES,
    state,
    history: [],
    player: { provider: "fake", model: "m" },
    settings: { retries: 2, timeoutMs: 5000 },
    seed: 42,
    ...patch,
  };
}

function fakeRegistry(generate: (r: GenerateRequest) => Promise<string>): Map<string, ProviderAdapter> {
  const adapter: ProviderAdapter = {
    id: "fake",
    label: "Fake",
    status: async () => ({ ready: true, detail: "", models: [], freeformModels: true, defaultModel: "m" }),
    generate,
  };
  return new Map([["fake", adapter]]);
}

const never = new AbortController().signal;

describe("decide()", () => {
  it("returns a legal action and the model's own explanation", async () => {
    const registry = fakeRegistry(async () => '{"action":"move","to":[1,5],"explanation":"Heading for the west uplink."}');
    const out = await decide(request(), board, registry, never);
    expect(out).toMatchObject({ ok: true, action: { type: "move", to: [1, 5] }, explanation: "Heading for the west uplink.", fallback: false, attempts: [] });
  });

  it("does not invent an explanation when the model gives none", async () => {
    const out = await decide(request(), board, fakeRegistry(async () => '{"action":"brace"}'), never);
    expect(out).toMatchObject({ ok: true, explanation: "" });
  });

  it("retries malformed and illegal replies, telling the model why", async () => {
    const prompts: string[] = [];
    const replies = ["I think I'll flank", '{"action":"move","to":[8,8]}', '{"action":"overwatch"}'];
    const registry = fakeRegistry(async (r) => {
      prompts.push(r.prompt);
      return replies[r.attempt];
    });
    const out = await decide(request(), board, registry, never, { backoffMs: 0 });
    expect(out).toMatchObject({ ok: true, action: { type: "overwatch" }, fallback: false });
    expect(out.attempts.map((a) => a.kind)).toEqual(["parse", "illegal"]);
    expect(out.attempts[0].excerpt).toContain("flank");
    expect(prompts[1]).toMatch(/previous reply was rejected: no JSON action/);
    expect(prompts[2]).toMatch(/not reachable/);
  });

  it("falls back to brace when every reply is unusable, and flags it", async () => {
    const out = await decide(request(), board, fakeRegistry(async () => '{"action":"fire"}'), never, { backoffMs: 0 });
    expect(out).toMatchObject({ ok: true, action: { type: "brace" }, fallback: true, explanation: "" });
    expect(out.attempts).toHaveLength(3);
    expect(out.attempts.every((a) => a.kind === "illegal")).toBe(true);
  });

  it("stops at once on setup errors so the match can pause visibly", async () => {
    let calls = 0;
    const out = await decide(
      request(),
      board,
      fakeRegistry(async () => {
        calls++;
        throw new ProviderError("Fake rejected the API key (401)", false);
      }),
      never,
      { backoffMs: 0 },
    );
    expect(calls).toBe(1);
    expect(out).toMatchObject({ ok: false, retryable: false, error: expect.stringMatching(/401/) });
  });

  it("retries transient provider errors and then succeeds", async () => {
    const out = await decide(
      request(),
      board,
      fakeRegistry(async (r) => {
        if (r.attempt < 2) throw new ProviderError("rate limit (429)", true);
        return '{"action":"brace"}';
      }),
      never,
      { backoffMs: 0 },
    );
    expect(out).toMatchObject({ ok: true, fallback: false });
    expect(out.attempts.map((a) => a.kind)).toEqual(["provider", "provider"]);
  });

  it("times out a hanging provider and reports it as retryable", async () => {
    const hang = fakeRegistry((r) => new Promise((_, reject) => r.signal.addEventListener("abort", () => reject(r.signal.reason))));
    const req = request({ settings: { retries: 1, timeoutMs: 5000 } });
    // Shrink the timeout below the protocol minimum for the test only.
    req.settings.timeoutMs = 30;
    const out = await decide(req, board, hang, never, { backoffMs: 0 });
    expect(out).toMatchObject({ ok: false, retryable: true });
    expect(out.attempts.map((a) => a.kind)).toEqual(["timeout", "timeout"]);
  });

  it("throws CancelledError when the client goes away", async () => {
    const controller = new AbortController();
    const hang = fakeRegistry((r) => new Promise((_, reject) => r.signal.addEventListener("abort", () => reject(r.signal.reason))));
    const pending = decide(request(), board, hang, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
  });

  it("plays the glitch mock through retries without crashing", async () => {
    const registry = createRegistry({}, { mockLatencyMs: 0 });
    let state = createInitialState(board, DEFAULT_RULES, "A");
    state = { ...state, turn: 3 };
    const out = await decide(request({ state, turn: 3, player: { provider: "mock", model: "glitch" } }), board, registry, never, { backoffMs: 0 });
    expect(out.ok).toBe(true);
    expect(out.attempts).toHaveLength(1);
  });
});

describe("parseDecisionRequest()", () => {
  const roundTrip = (r: unknown) => parseDecisionRequest(JSON.parse(JSON.stringify(r)));

  it("accepts a well-formed request", () => {
    expect(roundTrip(request()).ok).toBe(true);
  });

  it("rejects stale or inconsistent state", () => {
    const base = request();
    expect(roundTrip({ ...base, side: "B" })).toMatchObject({ ok: false, error: expect.stringMatching(/turn/) });
    expect(roundTrip({ ...base, turn: 7 })).toMatchObject({ ok: false });
    expect(roundTrip({ ...base, mapId: "nowhere" })).toMatchObject({ ok: false, error: "unknown map" });
    const hacked = structuredClone(base);
    hacked.state.robots.A.hp = 999;
    expect(roundTrip(hacked)).toMatchObject({ ok: false, error: "invalid game state" });
    const over = structuredClone(base);
    over.state.result = { winner: "A", reason: "score", detail: "" };
    expect(roundTrip(over)).toMatchObject({ ok: false, error: expect.stringMatching(/over/) });
    expect(roundTrip({ ...base, settings: { retries: 50, timeoutMs: 1000 } })).toMatchObject({ ok: false });
  });
});

describe("DecisionGate", () => {
  it("refuses duplicates, cancels superseded requests, refuses older ones", () => {
    const gate = new DecisionGate();
    const first = gate.begin("m1", 1, 4);
    expect(first.ok).toBe(true);
    expect(gate.begin("m1", 1, 4)).toMatchObject({ ok: false, error: expect.stringMatching(/already/) });
    expect(gate.begin("m1", 1, 3)).toMatchObject({ ok: false, error: expect.stringMatching(/older/) });
    const newer = gate.begin("m1", 2, 1);
    expect(newer.ok).toBe(true);
    if (first.ok) expect(first.controller.signal.aborted).toBe(true);
    if (first.ok) first.release(); // a late release of the old slot must not free the new one
    expect(gate.size).toBe(1);
    if (newer.ok) newer.release();
    expect(gate.size).toBe(0);
  });
});

describe("HTTP API", () => {
  let server: Server | null = null;
  // Listing providers asks the CLIs who is signed in; tests must not start the real, slow ones.
  beforeEach(() => {
    process.env.CLAUDE_BIN = process.env.CODEX_BIN = "uplink-test-no-such-cli";
  });
  afterEach(() => {
    delete process.env.CLAUDE_BIN;
    delete process.env.CODEX_BIN;
    server?.close();
  });

  async function listen(registry: Map<string, ProviderAdapter>): Promise<string> {
    const api = createApi({ registry, backoffMs: 0 });
    server = createServer((req, res) => api(req, res, () => res.writeHead(404).end()));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("never exposes API keys in the provider list", async () => {
    const base = await listen(createRegistry({ OPENAI_API_KEY: "sk-secret-123", ANTHROPIC_API_KEY: "sk-ant-secret-456" }, { mockLatencyMs: 0 }));
    const text = await (await fetch(`${base}/api/providers`)).text();
    expect(text).not.toContain("secret");
    const infos = JSON.parse(text).providers as { id: string; ready: boolean }[];
    expect(infos.find((p) => p.id === "mock")?.ready).toBe(true);
    expect(infos.find((p) => p.id === "openai")?.ready).toBe(true);
    expect(infos.find((p) => p.id === "gemini")?.ready).toBe(false);
  });

  it("rejects cross-origin and non-JSON requests", async () => {
    const base = await listen(createRegistry({}, { mockLatencyMs: 0 }));
    const cross = await fetch(`${base}/api/decide`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
    expect(cross.status).toBe(403);
    const form = await fetch(`${base}/api/decide`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    expect(form.status).toBe(403);
  });

  it("answers one request per turn and refuses a concurrent duplicate", async () => {
    let release: () => void = () => {};
    const gateOpen = new Promise<void>((r) => (release = r));
    const base = await listen(
      fakeRegistry(async () => {
        await gateOpen;
        return '{"action":"brace"}';
      }),
    );
    const post = () => fetch(`${base}/api/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request()) });
    const first = post();
    await new Promise((r) => setTimeout(r, 50));
    const duplicate = await post();
    expect(duplicate.status).toBe(409);
    release();
    const ok = await first;
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, action: { type: "brace" }, turn: 1, epoch: 1 });
  });

  it("lists every registered provider", async () => {
    const infos = await providerInfos(createRegistry({ CUSTOM_OPENAI_BASE_URL: "http://127.0.0.1:9/v1", CUSTOM_OPENAI_MODELS: "a,b" }, { mockLatencyMs: 0 }));
    expect(infos.map((p) => p.id)).toEqual(["mock", "claude-cli", "codex-cli", "anthropic", "openai", "gemini", "openrouter", "ollama", "custom"]);
  });
});
