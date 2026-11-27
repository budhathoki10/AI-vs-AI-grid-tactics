import type { Attempt, DecisionRequest, DecisionResponse } from "../src/ai/protocol";
import { fallbackAction, validateAction } from "../src/engine/engine";
import { inBounds } from "../src/engine/geometry";
import { buildBoard, getMap, MAPS } from "../src/engine/maps";
import { parseReply } from "../src/engine/parse";
import { buildPrompt, buildSnapshot, SYSTEM_PROMPT } from "../src/engine/snapshot";
import type { Board, GameState, RulesConfig } from "../src/engine/types";
import { ProviderError, type ProviderAdapter } from "./providers/types";

export const MAX_RETRIES = 4;
export const MIN_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 300_000;
const EXCERPT_CHARS = 240;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

function readRules(v: unknown): RulesConfig | null {
  if (!isObj(v)) return null;
  const keys: [keyof RulesConfig, number, number][] = [
    ["maxHp", 1, 99],
    ["moveRange", 1, 10],
    ["fireRange", 1, 20],
    ["fireDamage", 0, 99],
    ["overwatchDamage", 0, 99],
    ["coverReduction", 0, 99],
    ["braceReduction", 0, 99],
    ["minDamage", 0, 99],
    ["scoreToWin", 1, 999],
    ["turnLimit", 2, 400],
  ];
  const out = {} as RulesConfig;
  for (const [key, min, max] of keys) {
    if (!isInt(v[key], min, max)) return null;
    out[key] = v[key] as number;
  }
  return out;
}

function stateIsSane(board: Board, rules: RulesConfig, s: unknown): s is GameState {
  if (!isObj(s) || !isObj(s.robots) || !isObj(s.owners)) return false;
  if (!isInt(s.turn, 1, rules.turnLimit) || (s.active !== "A" && s.active !== "B")) return false;
  for (const side of ["A", "B"] as const) {
    const r = (s.robots as Record<string, unknown>)[side];
    if (!isObj(r) || r.side !== side || !Array.isArray(r.pos) || !inBounds(board, r.pos as [number, number])) return false;
    if (!isInt(r.hp, 0, rules.maxHp) || !isInt(r.score, 0, 9999) || typeof r.braced !== "boolean" || typeof r.overwatch !== "boolean" || typeof r.recharging !== "boolean") return false;
  }
  return board.uplinks.every((u) => {
    const owner = (s.owners as Record<string, unknown>)[u.id];
    return owner === null || owner === "A" || owner === "B";
  });
}

/** Strict validation of an untrusted request body. The client is never trusted to send a consistent state. */
export function parseDecisionRequest(body: unknown): Parsed<{ request: DecisionRequest; board: Board }> {
  if (!isObj(body)) return { ok: false, error: "body must be a JSON object" };
  const { matchId, epoch, turn, side, mapId, swapStarts, history, player, settings, seed } = body;
  if (typeof matchId !== "string" || !/^[\w-]{4,64}$/.test(matchId)) return { ok: false, error: "invalid matchId" };
  if (!isInt(epoch, 0, Number.MAX_SAFE_INTEGER) || !isInt(seed, 0, 2 ** 32)) return { ok: false, error: "invalid epoch or seed" };
  if (typeof mapId !== "string" || !MAPS.some((m) => m.id === mapId)) return { ok: false, error: "unknown map" };
  const rules = readRules(body.rules);
  if (!rules) return { ok: false, error: "invalid rules" };
  const board = buildBoard(getMap(mapId), swapStarts === true);
  if (!stateIsSane(board, rules, body.state)) return { ok: false, error: "invalid game state" };
  const state = body.state;
  if (state.result) return { ok: false, error: "the match is already over" };
  if (side !== state.active) return { ok: false, error: `it is Robot ${state.active}'s turn` };
  if (turn !== state.turn) return { ok: false, error: "turn does not match the state" };
  if (!Array.isArray(history) || history.length > 400) return { ok: false, error: "invalid history" };
  if (!isObj(player) || typeof player.provider !== "string" || typeof player.model !== "string" || player.model.length > 200)
    return { ok: false, error: "invalid player" };
  // Model ids and effort reach a CLI's argv, so only plain identifier characters are accepted.
  if (player.model && !/^[\w.:/@~-]+$/.test(player.model)) return { ok: false, error: "invalid model id" };
  if (player.effort !== undefined && (typeof player.effort !== "string" || !/^(default|low|medium|high|xhigh|max)$/.test(player.effort)))
    return { ok: false, error: "invalid effort" };
  if (!isObj(settings) || !isInt(settings.retries, 0, MAX_RETRIES) || !isInt(settings.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS))
    return { ok: false, error: "invalid settings" };
  const key = player.provider === "openrouter" ? body.openRouterKey : undefined;
  // The key goes into an HTTP header, so only printable ASCII is accepted.
  if (key !== undefined && (typeof key !== "string" || !/^[\x21-\x7e]{1,300}$/.test(key))) return { ok: false, error: "invalid OpenRouter key" };
  return {
    ok: true,
    value: {
      board,
      request: {
        matchId,
        epoch,
        turn,
        side: state.active,
        mapId,
        swapStarts: swapStarts === true,
        rules,
        state,
        history: history as DecisionRequest["history"],
        player: { provider: player.provider, model: player.model, ...(typeof player.effort === "string" ? { effort: player.effort } : {}) },
        settings: { retries: settings.retries, timeoutMs: settings.timeoutMs },
        seed,
        ...(key ? { openRouterKey: key } : {}),
      },
    },
  };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}

export class CancelledError extends Error {
  constructor() {
    super("The request was cancelled");
    this.name = "CancelledError";
  }
}

/**
 * Asks the active robot's model for one action and guarantees the answer is legal.
 * - Malformed or illegal replies are retried with the rejection reason in the prompt.
 * - Retryable provider failures (timeouts, rate limits, network) are retried with backoff.
 * - Setup failures (no key, unknown model) return an error so the match pauses visibly.
 * - If replies kept coming back unusable, the engine braces on the model's behalf, flagged as a fallback.
 */
export async function decide(
  request: DecisionRequest,
  board: Board,
  registry: Map<string, ProviderAdapter>,
  signal: AbortSignal,
  options: { backoffMs?: number } = {},
): Promise<DecisionResponse> {
  const started = Date.now();
  const { turn, epoch, rules, state, player, settings } = request;
  const attempts: Attempt[] = [];
  const base = { turn, epoch };
  const adapter = registry.get(player.provider);
  if (!adapter) return { ok: false, ...base, error: `Unknown provider "${player.provider}"`, retryable: false, attempts, durationMs: 0 };
  if (!player.model) return { ok: false, ...base, error: "No model selected", retryable: false, attempts, durationMs: 0 };

  const snapshot = buildSnapshot(board, rules, state, request.history);
  const backoffMs = options.backoffMs ?? 800;
  let lastRejection: string | undefined;
  let sawReply = false;

  for (let attempt = 0; attempt <= settings.retries; attempt++) {
    const attemptStart = Date.now();
    const timeout = AbortSignal.timeout(settings.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let reply: string;
    try {
      reply = await adapter.generate({
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(rules, snapshot, lastRejection),
        model: player.model,
        effort: player.effort,
        openRouterKey: request.openRouterKey,
        signal: combined,
        attempt,
        context: { board, rules, state, snapshot, seed: request.seed },
      });
    } catch (error) {
      if (signal.aborted) throw new CancelledError();
      const ms = Date.now() - attemptStart;
      if (timeout.aborted) {
        attempts.push({ kind: "timeout", error: `no answer within ${Math.round(settings.timeoutMs / 1000)}s`, excerpt: "", durationMs: ms });
      } else if (error instanceof ProviderError) {
        attempts.push({ kind: "provider", error: error.message, excerpt: "", durationMs: ms });
        if (!error.retryable) return { ok: false, ...base, error: error.message, retryable: false, attempts, durationMs: Date.now() - started };
      } else {
        const message = `Unexpected provider failure: ${(error as Error)?.message ?? String(error)}`;
        attempts.push({ kind: "provider", error: message, excerpt: "", durationMs: ms });
        return { ok: false, ...base, error: message, retryable: false, attempts, durationMs: Date.now() - started };
      }
      if (attempt < settings.retries) {
        try {
          await abortableDelay(Math.min(backoffMs * 2 ** attempt, 6000), signal);
        } catch {
          throw new CancelledError();
        }
      }
      continue;
    }

    sawReply = true;
    const ms = Date.now() - attemptStart;
    const excerpt = reply.replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS);
    const parsed = parseReply(reply);
    if (!parsed.ok) {
      lastRejection = parsed.reason;
      attempts.push({ kind: "parse", error: parsed.reason, excerpt, durationMs: ms });
      continue;
    }
    const legal = validateAction(board, rules, state, request.side, parsed.action);
    if (!legal.ok) {
      lastRejection = legal.reason;
      attempts.push({ kind: "illegal", error: legal.reason, excerpt, durationMs: ms });
      continue;
    }
    return { ok: true, ...base, action: legal.action, explanation: parsed.explanation, fallback: false, attempts, durationMs: Date.now() - started };
  }

  if (!sawReply) {
    const last = attempts[attempts.length - 1];
    return { ok: false, ...base, error: last?.error ?? "The provider did not answer", retryable: true, attempts, durationMs: Date.now() - started };
  }
  return { ok: true, ...base, action: fallbackAction(board, rules, state), explanation: "", fallback: true, attempts, durationMs: Date.now() - started };
}

interface InFlight {
  turn: number;
  epoch: number;
  controller: AbortController;
}

/**
 * At most one decision per match is ever in flight. The same (match, epoch, turn) arriving twice is a
 * duplicate and is refused; a request for a newer turn or epoch supersedes and cancels the old one.
 */
export class DecisionGate {
  private readonly inFlight = new Map<string, InFlight>();

  begin(matchId: string, epoch: number, turn: number): { ok: true; controller: AbortController; release: () => void } | { ok: false; error: string } {
    const current = this.inFlight.get(matchId);
    if (current) {
      if (current.epoch === epoch && current.turn === turn) return { ok: false, error: "A decision for this turn is already in progress" };
      if (current.epoch > epoch || (current.epoch === epoch && current.turn > turn)) return { ok: false, error: "This request is older than one already in progress" };
      current.controller.abort();
    }
    const entry: InFlight = { turn, epoch, controller: new AbortController() };
    this.inFlight.set(matchId, entry);
    return {
      ok: true,
      controller: entry.controller,
      release: () => {
        if (this.inFlight.get(matchId) === entry) this.inFlight.delete(matchId);
      },
    };
  }

  get size(): number {
    return this.inFlight.size;
  }
}
