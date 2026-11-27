import type { DecisionRequest, DecisionResponse, DecisionSettings, PlayerConfig } from "../ai/protocol";
import { applyAction, fallbackAction, validateAction } from "../engine/engine";
import { buildBoard, getMap } from "../engine/maps";
import { newRecord, type MatchRecord, type TurnRecord } from "../engine/record";
import type { HistoryLine } from "../engine/snapshot";
import type { Board, GameState, RulesConfig, Side } from "../engine/types";

export type Phase = "ready" | "thinking" | "executing" | "waiting" | "paused" | "error" | "over" | "stopped";

export interface MatchConfig {
  id: string;
  players: Record<Side, PlayerConfig>;
  mapId: string;
  swapStarts: boolean;
  firstSide: Side;
  rules: RulesConfig;
  settings: DecisionSettings;
  /** Pause between turns so viewers can follow. Can be changed live. */
  delayMs: number;
  seed: number;
  series?: MatchRecord["series"];
}

export interface Decider {
  decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResponse>;
}

/** Plays a completed decision on screen. The runner waits for it before the opponent is asked anything. */
export interface Presenter {
  present(turn: TurnRecord, board: Board): Promise<void>;
  /** Skip any running animation immediately (used by stop/restart). */
  interrupt?(): void;
}

export interface RunnerError {
  side: Side;
  message: string;
  retryable: boolean;
  /** Failed attempts behind this error (provider errors, timeouts, rejected replies). */
  attempts?: DecisionResponse["attempts"];
}

export interface RunnerSnapshot {
  phase: Phase;
  state: GameState;
  record: MatchRecord;
  /** Who is being asked, and since when, while a decision is in flight. */
  thinking: { side: Side; since: number; turn: number } | null;
  /** The turn currently animating. */
  executing: TurnRecord | null;
  /** A pause was requested; it takes effect at the next safe point. */
  pausePending: boolean;
  /** Paused with a decision already received but not yet executed. */
  holdingDecision: boolean;
  error: RunnerError | null;
  delayMs: number;
}

export interface RunnerOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onFinish?: (record: MatchRecord) => void;
}

const HISTORY_SENT = 12;

/**
 * Owns the authoritative match state and the strict turn order:
 * ask the active model → validate → animate → commit → (delay) → ask the other model.
 *
 * Exactly one loop runs per epoch. Every await is followed by an epoch check, so answers that
 * arrive after stop/restart are discarded instead of being applied to a newer match.
 */
export class MatchRunner {
  readonly board: Board;
  private snap: RunnerSnapshot;
  private readonly listeners = new Set<() => void>();
  private epoch = 0;
  private loopActive = false;
  private controller: AbortController | null = null;
  private pauseRequested = false;
  private resumeWaiters: (() => void)[] = [];
  private startedAt = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    readonly config: MatchConfig,
    private readonly decider: Decider,
    private presenter: Presenter | null = null,
    private readonly options: RunnerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.board = buildBoard(getMap(config.mapId), config.swapStarts);
    const record = newRecord({
      id: config.id,
      mapId: config.mapId,
      swapStarts: config.swapStarts,
      firstSide: config.firstSide,
      rules: config.rules,
      players: config.players,
      series: config.series,
    });
    this.snap = {
      phase: "ready",
      state: record.initialState,
      record,
      thinking: null,
      executing: null,
      pausePending: false,
      holdingDecision: false,
      error: null,
      delayMs: config.delayMs,
    };
  }

  // ---- external store protocol (React's useSyncExternalStore) ----
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): RunnerSnapshot => this.snap;

  private update(patch: Partial<RunnerSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const listener of this.listeners) listener();
  }

  setPresenter(presenter: Presenter | null): void {
    this.presenter = presenter;
  }

  // ---- controls ----
  start(): void {
    if (this.snap.phase !== "ready") return;
    this.startedAt = this.now();
    this.update({ record: { ...this.snap.record, createdAt: new Date(this.startedAt).toISOString() } });
    this.runLoop();
  }

  pause(): void {
    if (["over", "stopped", "paused", "ready"].includes(this.snap.phase) || this.pauseRequested) return;
    this.pauseRequested = true;
    if (this.snap.phase === "error") {
      this.update({ phase: "paused", pausePending: false });
      return;
    }
    this.update({ pausePending: true });
  }

  resume(): void {
    if (this.snap.phase === "error") return this.retry();
    if (!this.pauseRequested && this.snap.phase !== "paused") return;
    this.pauseRequested = false;
    this.update({ pausePending: false });
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const wake of waiters) wake();
    if (!this.loopActive && !this.isFinished()) this.runLoop();
  }

  /** Ask the same model again after a provider error. */
  retry(): void {
    if (this.snap.phase !== "error" && !(this.snap.phase === "paused" && this.snap.error)) return;
    this.pauseRequested = false;
    this.update({ error: null, pausePending: false });
    if (!this.loopActive) this.runLoop();
  }

  setDelay(ms: number): void {
    this.update({ delayMs: Math.max(0, Math.round(ms)) });
  }

  /** Ends the match safely: the in-flight request is cancelled and its answer, if any, is ignored. */
  stop(): void {
    if (this.isFinished()) return;
    this.epoch++;
    this.controller?.abort();
    this.presenter?.interrupt?.();
    const wakers = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const wake of wakers) wake();
    const turns = this.snap.record.turns.length;
    const result = { winner: null, reason: "stopped" as const, detail: `Stopped by the viewer after ${turns} action${turns === 1 ? "" : "s"}` };
    this.update({
      phase: "stopped",
      thinking: null,
      executing: null,
      pausePending: false,
      holdingDecision: false,
      state: { ...this.snap.state, result },
      record: this.finalRecord(result),
    });
    this.options.onFinish?.(this.snap.record);
  }

  /** Stop listening and cancel everything; for unmounting. */
  dispose(): void {
    this.epoch++;
    this.controller?.abort();
    this.listeners.clear();
  }

  private isFinished(): boolean {
    return this.snap.phase === "over" || this.snap.phase === "stopped";
  }

  private finalRecord(result: MatchRecord["result"]): MatchRecord {
    const finished = this.now();
    return { ...this.snap.record, result, finishedAt: new Date(finished).toISOString(), durationMs: this.startedAt ? finished - this.startedAt : 0 };
  }

  private waitForResume(epoch: number): Promise<void> {
    if (!this.pauseRequested || this.epoch !== epoch) return Promise.resolve();
    return new Promise((resolve) => this.resumeWaiters.push(resolve));
  }

  private history(): HistoryLine[] {
    return this.snap.record.turns.slice(-HISTORY_SENT).map(({ turn, side, action, events }) => ({ turn, side, action, events }));
  }

  private runLoop(): void {
    if (this.loopActive) return;
    this.loopActive = true;
    const epoch = this.epoch;
    this.loop(epoch)
      .catch((error) => {
        if (this.epoch !== epoch) return;
        this.update({ phase: "error", thinking: null, executing: null, error: { side: this.snap.state.active, message: `Runner failure: ${(error as Error).message}`, retryable: true } });
      })
      .finally(() => {
        if (this.epoch === epoch) this.loopActive = false;
      });
  }

  private async loop(epoch: number): Promise<void> {
    const live = () => this.epoch === epoch;
    while (live()) {
      const state = this.snap.state;
      if (state.result) return;

      if (this.pauseRequested) {
        this.update({ phase: "paused", pausePending: false, thinking: null });
        await this.waitForResume(epoch);
        if (!live()) return;
      }

      // 1–3. Send the authoritative state to the active model and wait for its decision.
      const side = state.active;
      const controller = new AbortController();
      this.controller = controller;
      this.update({ phase: "thinking", thinking: { side, since: this.now(), turn: state.turn }, error: null });
      const request: DecisionRequest = {
        matchId: this.config.id,
        epoch,
        turn: state.turn,
        side,
        mapId: this.config.mapId,
        swapStarts: this.config.swapStarts,
        rules: this.config.rules,
        state,
        history: this.history(),
        player: { provider: this.config.players[side].provider, model: this.config.players[side].model, effort: this.config.players[side].effort },
        settings: this.config.settings,
        seed: this.config.seed,
      };

      let response: DecisionResponse;
      try {
        response = await this.decider.decide(request, controller.signal);
      } catch (error) {
        if (!live()) return;
        this.update({ phase: "error", thinking: null, error: { side, message: (error as Error).message || "The decision request failed", retryable: true } });
        return;
      } finally {
        if (this.controller === controller) this.controller = null;
      }
      if (!live()) return; // stopped or restarted while the model was thinking
      if (response.turn !== state.turn || response.epoch !== epoch || this.snap.state !== state) {
        this.update({ phase: "error", thinking: null, error: { side, message: "Received a decision for a different turn; it was discarded", retryable: true } });
        return;
      }
      if (!response.ok) {
        this.update({ phase: "error", thinking: null, error: { side, message: response.error, retryable: response.retryable, attempts: response.attempts } });
        return;
      }

      // 4. Validate again locally; the engine never trusts the transport either.
      let action = response.action;
      let fallback = response.fallback;
      const check = validateAction(this.board, this.config.rules, state, side, action);
      if (!check.ok) {
        action = fallbackAction(this.board, this.config.rules, state);
        fallback = true;
      }
      const applied = applyAction(this.board, this.config.rules, state, action);
      const turn: TurnRecord = {
        turn: state.turn,
        side,
        action,
        explanation: fallback ? "" : response.explanation,
        legal: !fallback,
        fallback,
        attempts: response.attempts,
        decisionMs: response.durationMs,
        events: applied.events,
        stateBefore: state,
        stateAfter: applied.state,
      };

      if (this.pauseRequested) {
        this.update({ phase: "paused", pausePending: false, thinking: null, holdingDecision: true });
        await this.waitForResume(epoch);
        if (!live()) return;
        this.update({ holdingDecision: false });
      }

      // 5. Execute and finish the animation before anything else happens.
      this.update({ phase: "executing", thinking: null, executing: turn });
      if (this.presenter) {
        try {
          await this.presenter.present(turn, this.board);
        } catch {
          /* a rendering problem must never corrupt the match */
        }
      }
      if (!live()) return;

      // 6. Commit the new authoritative state.
      const record = { ...this.snap.record, turns: [...this.snap.record.turns, turn] };
      this.update({ state: applied.state, record, executing: null });
      if (applied.state.result) {
        this.update({ phase: "over", record: this.finalRecord(applied.state.result) });
        this.options.onFinish?.(this.snap.record);
        return;
      }

      // 7. Viewing delay, then the opponent receives the updated state on the next iteration.
      this.update({ phase: "waiting" });
      const waitStart = this.now();
      while (live() && !this.pauseRequested) {
        const remaining = this.snap.delayMs - (this.now() - waitStart);
        if (remaining <= 0) break;
        await this.sleep(Math.min(remaining, 100));
      }
    }
  }
}

export function planSeries(base: Omit<MatchConfig, "id" | "series">, games: number, seriesId: string, makeId: () => string): MatchConfig[] {
  return Array.from({ length: games }, (_, i) => ({
    ...base,
    id: makeId(),
    seed: base.seed + i * 7919,
    // Alternate who moves first every game, and trade start tiles every second pair.
    firstSide: i % 2 === 0 ? base.firstSide : base.firstSide === "A" ? "B" : "A",
    swapStarts: Math.floor(i / 2) % 2 === 1 ? !base.swapStarts : base.swapStarts,
    series: { id: seriesId, game: i + 1, of: games },
  }));
}
