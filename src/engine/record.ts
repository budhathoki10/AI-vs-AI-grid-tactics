import type { Attempt, PlayerConfig } from "../ai/protocol";
import { applyAction, createInitialState, describeAction } from "./engine";
import { buildBoard, getMap } from "./maps";
import { RULES_VERSION } from "./rules";
import { describeEvents } from "./snapshot";
import type { Action, GameEvent, GameResult, GameState, RulesConfig, Side } from "./types";

export const RECORD_FORMAT = "uplink-duel/match";
/** Bump when the stored shape changes; `upgradeRecord` must learn to read older versions. */
export const RECORD_VERSION = 1;

export interface TurnRecord {
  turn: number;
  side: Side;
  action: Action;
  /** The model's explanation as given, or "" when it did not provide one. */
  explanation: string;
  /** False when the engine had to substitute a fallback action. */
  legal: boolean;
  fallback: boolean;
  attempts: Attempt[];
  decisionMs: number;
  events: GameEvent[];
  stateBefore: GameState;
  stateAfter: GameState;
}

export interface MatchRecord {
  format: typeof RECORD_FORMAT;
  version: number;
  rulesVersion: number;
  id: string;
  createdAt: string;
  finishedAt: string | null;
  durationMs: number;
  mapId: string;
  swapStarts: boolean;
  firstSide: Side;
  rules: RulesConfig;
  players: Record<Side, PlayerConfig>;
  initialState: GameState;
  turns: TurnRecord[];
  result: GameResult | null;
  series?: { id: string; game: number; of: number };
}

export function isMatchRecord(value: unknown): value is MatchRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<MatchRecord>;
  return r.format === RECORD_FORMAT && typeof r.version === "number" && Array.isArray(r.turns) && !!r.players && !!r.initialState && typeof r.mapId === "string";
}

/** Reads any supported version. Throws with a clear message for files this build cannot read. */
export function upgradeRecord(value: unknown): MatchRecord {
  if (!isMatchRecord(value)) throw new Error("This file is not an Uplink Duel match record");
  if (value.version > RECORD_VERSION) throw new Error(`Match record version ${value.version} is newer than this app supports (${RECORD_VERSION})`);
  return value;
}

export function newRecord(init: {
  id: string;
  mapId: string;
  swapStarts: boolean;
  firstSide: Side;
  rules: RulesConfig;
  players: Record<Side, PlayerConfig>;
  series?: MatchRecord["series"];
}): MatchRecord {
  const board = buildBoard(getMap(init.mapId), init.swapStarts);
  return {
    format: RECORD_FORMAT,
    version: RECORD_VERSION,
    rulesVersion: RULES_VERSION,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: 0,
    initialState: createInitialState(board, init.rules, init.firstSide),
    turns: [],
    result: null,
    ...init,
  };
}

export interface ReplayCheck {
  ok: boolean;
  /** Turn where the recomputed state first diverged from the stored one. */
  divergedAt: number | null;
  states: GameState[];
}

/**
 * Re-applies every recorded action from the initial state with the engine. Because the rules are
 * deterministic, the recomputed states must match the stored ones exactly; any mismatch means the
 * record was edited or produced by different rules.
 */
export function verifyReplay(record: MatchRecord): ReplayCheck {
  const board = buildBoard(getMap(record.mapId), record.swapStarts);
  let state = record.initialState;
  const states = [state];
  for (const turn of record.turns) {
    try {
      state = applyAction(board, record.rules, state, turn.action).state;
    } catch {
      return { ok: false, divergedAt: turn.turn, states };
    }
    if (JSON.stringify(state) !== JSON.stringify(turn.stateAfter)) return { ok: false, divergedAt: turn.turn, states };
    states.push(state);
  }
  return { ok: true, divergedAt: null, states };
}

export interface KeyEvent {
  turn: number;
  side: Side | null;
  text: string;
}

/** A short list of the moments that shaped the match, derived only from recorded events. */
export function keyEvents(record: MatchRecord, name: (side: Side) => string = (s) => `Robot ${s}`): KeyEvent[] {
  const out: KeyEvent[] = [];
  const uplinks = buildBoard(getMap(record.mapId)).uplinks;
  let firstHit = false;
  for (const t of record.turns) {
    for (const e of t.events) {
      if (e.kind === "fired") {
        if (!firstHit) {
          out.push({ turn: t.turn, side: e.side, text: `${name(e.side)} landed the first hit (${e.damage} dmg)` });
          firstHit = true;
        } else if (e.reaction) {
          out.push({ turn: t.turn, side: e.side, text: `${name(e.side)}'s overwatch caught ${name(e.target)} for ${e.damage}` });
        }
      } else if (e.kind === "captured") {
        const uplink = uplinks.find((u) => u.id === e.uplinkId);
        out.push({ turn: t.turn, side: e.side, text: `${name(e.side)} ${e.from ? "took" : "captured"} the ${uplink?.name ?? e.uplinkId}` });
      } else if (e.kind === "disabled") {
        out.push({ turn: t.turn, side: e.side, text: `${name(e.side)} was disabled` });
      }
    }
    if (t.fallback) out.push({ turn: t.turn, side: t.side, text: `${name(t.side)} gave no usable action; the engine played a safe fallback` });
  }
  return out;
}

export interface SideStats {
  actions: Record<Action["type"], number>;
  damageDealt: number;
  avgDecisionMs: number;
  retries: number;
  fallbacks: number;
}

export function sideStats(record: MatchRecord, side: Side): SideStats {
  const stats: SideStats = { actions: { move: 0, fire: 0, brace: 0, overwatch: 0 }, damageDealt: 0, avgDecisionMs: 0, retries: 0, fallbacks: 0 };
  let total = 0;
  let count = 0;
  for (const t of record.turns) {
    for (const e of t.events) if (e.kind === "fired" && e.side === side) stats.damageDealt += e.damage;
    if (t.side !== side) continue;
    stats.actions[t.action.type]++;
    stats.retries += t.attempts.length;
    if (t.fallback) stats.fallbacks++;
    total += t.decisionMs;
    count++;
  }
  stats.avgDecisionMs = count ? Math.round(total / count) : 0;
  return stats;
}

export function turnSummary(t: TurnRecord): string {
  return `${describeAction(t.action)} — ${describeEvents(t.events) || "no effect"}`;
}
