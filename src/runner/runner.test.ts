import { describe, expect, it } from "vitest";
import { CancelledError, decide } from "../../server/decide";
import { createRegistry } from "../../server/providers/registry";
import type { DecisionRequest, DecisionResponse, PlayerConfig } from "../ai/protocol";
import { buildBoard, getMap } from "../engine/maps";
import type { Action } from "../engine/types";
import { keyEvents, upgradeRecord, verifyReplay, type MatchRecord } from "../engine/record";
import { DEFAULT_RULES } from "../engine/rules";
import { MatchRunner, planSeries, type Decider, type MatchConfig, type Presenter } from "./MatchRunner";

const player = (model: string, color: string): PlayerConfig => ({ provider: "mock", model, name: model, color });

function config(patch: Partial<MatchConfig> = {}): MatchConfig {
  return {
    id: `match-${Math.random().toString(36).slice(2, 10)}`,
    players: { A: player("tactician", "#3d7bff"), B: player("sentinel", "#ff5a3c") },
    mapId: "foundry",
    swapStarts: false,
    firstSide: "A",
    rules: DEFAULT_RULES,
    settings: { retries: 2, timeoutMs: 10_000 },
    delayMs: 0,
    seed: 7,
    ...patch,
  };
}

/** Runs the real server pipeline in-process with instant mocks. */
function inProcessDecider(): Decider {
  const registry = createRegistry({}, { mockLatencyMs: 0 });
  return {
    decide(request, signal) {
      const board = buildBoard(getMap(request.mapId), request.swapStarts);
      return decide(request, board, registry, signal, { backoffMs: 0 });
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep0 = () => Promise.resolve();

function finished(runner: MatchRunner): Promise<MatchRecord> {
  return new Promise((resolve) => {
    const check = () => {
      const s = runner.getSnapshot();
      if (s.phase === "over" || s.phase === "stopped") resolve(s.record);
    };
    runner.subscribe(check);
    check();
  });
}

/** A decider whose answers the test releases by hand. */
function manualDecider() {
  const pending: { request: DecisionRequest; signal: AbortSignal; resolve: (r: DecisionResponse) => void; reject: (e: unknown) => void }[] = [];
  const decider: Decider = {
    decide: (request, signal) =>
      new Promise((resolve, reject) => {
        pending.push({ request, signal, resolve, reject });
        signal.addEventListener("abort", () => reject(new CancelledError()));
      }),
  };
  const answer = (i: number, action: Action) => {
    const p = pending[i];
    p.resolve({ ok: true, turn: p.request.turn, epoch: p.request.epoch, action, explanation: "", fallback: false, attempts: [], durationMs: 5 });
  };
  return { decider, pending, answer };
}

describe("MatchRunner turn order", () => {
  it("asks one model at a time, animates, commits, then gives the opponent the updated state", async () => {
    const log: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const real = inProcessDecider();
    const decider: Decider = {
      async decide(request, signal) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        log.push(`decide T${request.turn} ${request.side}`);
        try {
          return await real.decide(request, signal);
        } finally {
          inFlight--;
        }
      },
    };
    const presenter: Presenter = {
      async present(turn) {
        log.push(`present T${turn.turn} ${turn.side}`);
        await tick();
      },
    };
    const runner = new MatchRunner(config({ rules: { ...DEFAULT_RULES, turnLimit: 8 } }), decider, presenter, { sleep: sleep0 });
    const seenStates: unknown[] = [];
    const recordDone = finished(runner);
    const original = decider.decide.bind(decider);
    decider.decide = (request, signal) => {
      seenStates.push(request.state);
      return original(request, signal);
    };
    runner.start();
    const record = await recordDone;

    expect(maxInFlight).toBe(1);
    expect(log).toEqual(Array.from({ length: 8 }, (_, i) => [`decide T${i + 1} ${i % 2 ? "B" : "A"}`, `present T${i + 1} ${i % 2 ? "B" : "A"}`]).flat());
    // Each model saw exactly the state produced by the previous action.
    record.turns.forEach((turn, i) => {
      expect(seenStates[i]).toEqual(turn.stateBefore);
      if (i > 0) expect(turn.stateBefore).toEqual(record.turns[i - 1].stateAfter);
    });
    expect(record.result?.reason).toBe("turn-limit");
  });

  it("calling start or resume repeatedly never starts a second loop", async () => {
    const { decider, pending, answer } = manualDecider();
    const runner = new MatchRunner(config(), decider, null, { sleep: sleep0 });
    runner.start();
    runner.start();
    runner.resume();
    await tick();
    expect(pending).toHaveLength(1);
    answer(0, { type: "brace" });
    await tick();
    await tick();
    runner.resume();
    expect(pending).toHaveLength(2);
    expect(pending[1].request.turn).toBe(2);
    expect(pending[1].request.side).toBe("B");
  });

  it("pausing while a model thinks holds the decision until resume", async () => {
    const { decider, answer } = manualDecider();
    let presented = 0;
    const runner = new MatchRunner(config(), decider, { present: async () => void presented++ }, { sleep: sleep0 });
    runner.start();
    await tick();
    runner.pause();
    expect(runner.getSnapshot()).toMatchObject({ phase: "thinking", pausePending: true });
    answer(0, { type: "overwatch" });
    await tick();
    expect(runner.getSnapshot()).toMatchObject({ phase: "paused", holdingDecision: true });
    expect(presented).toBe(0);
    expect(runner.getSnapshot().record.turns).toHaveLength(0);
    runner.resume();
    await tick();
    await tick();
    expect(presented).toBe(1);
    expect(runner.getSnapshot().record.turns[0].action).toEqual({ type: "overwatch" });
  });

  it("stop cancels the in-flight request and ignores its late answer", async () => {
    const { decider, pending } = manualDecider();
    const runner = new MatchRunner(config(), decider, null, { sleep: sleep0 });
    runner.start();
    await tick();
    runner.stop();
    expect(pending[0].signal.aborted).toBe(true);
    pending[0].resolve({ ok: true, turn: 1, epoch: 0, action: { type: "brace" }, explanation: "", fallback: false, attempts: [], durationMs: 1 });
    await tick();
    const snap = runner.getSnapshot();
    expect(snap.phase).toBe("stopped");
    expect(snap.record.turns).toHaveLength(0);
    expect(snap.record.result).toMatchObject({ reason: "stopped", winner: null });
  });

  it("discards an answer for a different turn", async () => {
    const { decider, pending } = manualDecider();
    const runner = new MatchRunner(config(), decider, null, { sleep: sleep0 });
    runner.start();
    await tick();
    pending[0].resolve({ ok: true, turn: 5, epoch: pending[0].request.epoch, action: { type: "brace" }, explanation: "", fallback: false, attempts: [], durationMs: 1 });
    await tick();
    expect(runner.getSnapshot()).toMatchObject({ phase: "error", error: { message: expect.stringMatching(/different turn/) } });
    expect(runner.getSnapshot().record.turns).toHaveLength(0);
  });

  it("re-validates locally and substitutes a fallback for an illegal answer", async () => {
    const { decider, pending, answer } = manualDecider();
    const runner = new MatchRunner(config(), decider, null, { sleep: sleep0 });
    runner.start();
    await tick();
    answer(0, { type: "fire" }); // enemy is out of range at the start
    await tick();
    await tick();
    const turn = runner.getSnapshot().record.turns[0];
    expect(turn).toMatchObject({ action: { type: "brace" }, fallback: true, legal: false });
    expect(pending).toHaveLength(2);
  });

  it("pauses on provider errors and continues after retry", async () => {
    const { decider, pending, answer } = manualDecider();
    const runner = new MatchRunner(config(), decider, null, { sleep: sleep0 });
    runner.start();
    await tick();
    pending[0].resolve({ ok: false, turn: 1, epoch: pending[0].request.epoch, error: "No API key", retryable: false, attempts: [], durationMs: 1 });
    await tick();
    await tick();
    expect(runner.getSnapshot()).toMatchObject({ phase: "error", error: { message: "No API key", side: "A" } });
    runner.retry();
    await tick();
    expect(pending).toHaveLength(2);
    expect(pending[1].request.turn).toBe(1);
    answer(1, { type: "brace" });
    await tick();
    await tick();
    expect(runner.getSnapshot().record.turns).toHaveLength(1);
  });

  it("waits the viewing delay between turns and applies live delay changes", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const real = inProcessDecider();
    const runner = new MatchRunner(config({ delayMs: 1000, rules: { ...DEFAULT_RULES, turnLimit: 3 } }), real, null, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
        if (sleeps.length === 3) runner.setDelay(200);
      },
    });
    const done = finished(runner);
    runner.start();
    await done;
    // first gap: 100ms slices until 1000ms; after the change the remaining gap is short.
    expect(sleeps.slice(0, 3)).toEqual([100, 100, 100]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(2000);
  });
});

describe("complete mock matches", () => {
  it.each([
    ["foundry", "tactician", "sentinel"],
    ["basin", "aggressor", "opportunist"],
    ["foundry", "glitch", "wildcard"],
  ])("%s: %s vs %s plays to a result that replays exactly", async (mapId, a, b) => {
    const runner = new MatchRunner(config({ mapId, players: { A: player(a, "#3d7bff"), B: player(b, "#ff5a3c") } }), inProcessDecider(), null, { sleep: sleep0 });
    const done = finished(runner);
    runner.start();
    const record = await done;

    expect(record.result).not.toBeNull();
    expect(["disabled", "score", "turn-limit"]).toContain(record.result!.reason);
    expect(record.turns.length).toBeLessThanOrEqual(DEFAULT_RULES.turnLimit);
    expect(record.turns.every((t, i) => t.turn === i + 1)).toBe(true);
    expect(verifyReplay(record).ok).toBe(true);
    expect(keyEvents(record).length).toBeGreaterThan(0);

    // Saved records survive JSON and are readable by the loader.
    const restored = upgradeRecord(JSON.parse(JSON.stringify(record)));
    expect(verifyReplay(restored).ok).toBe(true);
    if (a === "glitch") expect(record.turns.some((t) => t.attempts.length > 0)).toBe(true);
  });
});

describe("match records", () => {
  it("detects a tampered record", async () => {
    const runner = new MatchRunner(config({ rules: { ...DEFAULT_RULES, turnLimit: 6 } }), inProcessDecider(), null, { sleep: sleep0 });
    const done = finished(runner);
    runner.start();
    const record = structuredClone(await done);
    record.turns[2].stateAfter.robots.A.hp = 1;
    expect(verifyReplay(record)).toMatchObject({ ok: false, divergedAt: 3 });
  });

  it("refuses files from a newer format or a different app", () => {
    expect(() => upgradeRecord({ hello: "world" })).toThrow(/not an Uplink Duel/);
    expect(() => upgradeRecord({ format: "uplink-duel/match", version: 99, turns: [], players: {}, initialState: {}, mapId: "x" })).toThrow(/newer/);
  });
});

describe("planSeries", () => {
  it("alternates the first mover and trades start tiles to cancel setup advantages", () => {
    let n = 0;
    const games = planSeries(config(), 4, "s1", () => `g${n++}`);
    expect(games.map((g) => [g.firstSide, g.swapStarts])).toEqual([
      ["A", false],
      ["B", false],
      ["A", true],
      ["B", true],
    ]);
    expect(games.map((g) => g.series)).toEqual([1, 2, 3, 4].map((game) => ({ id: "s1", game, of: 4 })));
    expect(new Set(games.map((g) => g.id)).size).toBe(4);
  });
});
