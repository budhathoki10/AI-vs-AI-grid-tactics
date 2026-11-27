import { applyAction, checkFire, computeDamage, legalActions } from "../engine/engine";
import { coordKey, manhattan, reachableTiles, sameCoord } from "../engine/geometry";
import type { Snapshot } from "../engine/snapshot";
import { otherSide, type Action, type Board, type GameState, type RulesConfig, type Side } from "../engine/types";
import type { ModelOption } from "./protocol";

/**
 * Built-in opponents that need no API key. They play through the exact same prompt → reply → parse →
 * validate pipeline as real models (they return reply text), so a mock match exercises everything.
 */
export const MOCK_MODELS: (ModelOption & { persona: Persona })[] = [
  { id: "tactician", label: "Tactician", hint: "Looks one reply ahead, balanced", persona: { depth: 2, safety: 1, aggression: 1, greed: 1, noise: 0.08 } },
  { id: "sentinel", label: "Sentinel", hint: "Cautious, loves cover and overwatch", persona: { depth: 2, safety: 1.8, aggression: 0.6, greed: 0.9, noise: 0.08 } },
  { id: "aggressor", label: "Aggressor", hint: "Closes in and trades shots", persona: { depth: 1, safety: 0.4, aggression: 2, greed: 0.7, noise: 0.15 } },
  { id: "opportunist", label: "Opportunist", hint: "Chases uplinks, avoids fights", persona: { depth: 1, safety: 1.2, aggression: 0.5, greed: 1.8, noise: 0.15 } },
  { id: "wildcard", label: "Wildcard", hint: "Random legal actions", persona: { depth: 0, safety: 0, aggression: 0, greed: 0, noise: 1 } },
  { id: "glitch", label: "Glitch", hint: "Tactician that sometimes sends broken replies (tests retries)", persona: { depth: 2, safety: 1, aggression: 1, greed: 1, noise: 0.08, glitchy: true } },
];

export interface Persona {
  depth: 0 | 1 | 2;
  safety: number;
  aggression: number;
  greed: number;
  noise: number;
  glitchy?: boolean;
}

/** Small deterministic PRNG so the same seed and turn always produce the same mock decision. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Walking distance from every tile to each uplink (walls and barriers respected), cached per board. */
const distanceCache = new WeakMap<Board, Map<string, Map<string, number>>>();
function walkDistance(board: Board, uplinkId: string, from: readonly [number, number]): number {
  let fields = distanceCache.get(board);
  if (!fields) {
    fields = new Map();
    for (const u of board.uplinks) {
      const field = new Map<string, number>([[coordKey(u.at), 0]]);
      for (const [key, path] of reachableTiles(board, u.at, board.width * board.height, null)) field.set(key, path.length - 1);
      fields.set(u.id, field);
    }
    distanceCache.set(board, fields);
  }
  return fields.get(uplinkId)?.get(coordKey(from)) ?? board.width + board.height;
}

function evaluate(board: Board, rules: RulesConfig, state: GameState, me: Side, p: Persona): number {
  const foe = otherSide(me);
  if (state.result) {
    if (state.result.winner === me) return 10_000;
    if (state.result.winner === foe) return -10_000;
    return 0;
  }
  const a = state.robots[me];
  const b = state.robots[foe];
  const turnsLeft = Math.max(0, rules.turnLimit - state.turn + 1) / 2;
  const income = (s: Side) => board.uplinks.reduce((sum, u) => (state.owners[u.id] === s ? sum + u.value : sum), 0);
  const horizon = Math.min(turnsLeft, 4);

  let v = 0;
  v += (a.score - b.score) * 1.0;
  v += (income(me) - income(foe)) * horizon * 0.9 * p.greed;
  // HP matters more as it gets low: being near 0 is close to losing.
  const hpValue = (hp: number) => hp * 1.1 + (hp <= 3 ? -(4 - hp) * 1.5 : 0);
  v += (hpValue(a.hp) - hpValue(b.hp)) * p.safety;

  // Positional pull towards uplinks we do not own.
  const targets = board.uplinks.filter((u) => state.owners[u.id] !== me);
  if (targets.length) {
    const nearest = Math.min(...targets.map((u) => walkDistance(board, u.id, a.pos) / u.value));
    v -= nearest * 0.35 * p.greed;
  }

  // Who threatens whom, from the side to move next.
  const meShot = checkFire(board, rules, a.pos, b.pos);
  const foeShot = checkFire(board, rules, b.pos, a.pos);
  if (state.active === me && meShot.canHit) v += computeDamage(rules, rules.fireDamage, b, meShot.cover).damage * 0.6 * p.aggression;
  if (state.active === foe && foeShot.canHit) v -= computeDamage(rules, rules.fireDamage, a, foeShot.cover).damage * 0.7 * p.safety;
  if (p.aggression > 1) v -= manhattan(a.pos, b.pos) * 0.15 * (p.aggression - 1);
  return v;
}

function search(board: Board, rules: RulesConfig, state: GameState, me: Side, p: Persona, depth: number): number {
  if (depth === 0 || state.result) return evaluate(board, rules, state, me, p);
  const actions = legalActions(board, rules, state);
  const maximizing = state.active === me;
  let best = maximizing ? -Infinity : Infinity;
  for (const action of actions) {
    const next = applyAction(board, rules, state, action).state;
    const value = search(board, rules, next, me, p, depth - 1);
    best = maximizing ? Math.max(best, value) : Math.min(best, value);
  }
  return best;
}

export interface MockDecision {
  action: Action;
  explanation: string;
}

export function mockDecide(board: Board, rules: RulesConfig, state: GameState, snapshot: Snapshot, persona: Persona, seed: number): MockDecision {
  const rand = mulberry32(seed ^ (state.turn * 2654435761));
  const actions = legalActions(board, rules, state);
  if (persona.depth === 0) {
    const action = actions[Math.floor(rand() * actions.length)];
    return { action, explanation: "Picked a random legal action." };
  }
  const me = state.active;
  let best = actions[0];
  let bestValue = -Infinity;
  for (const action of actions) {
    const next = applyAction(board, rules, state, action).state;
    const value = search(board, rules, next, me, persona, persona.depth - 1) + (rand() - 0.5) * persona.noise;
    if (value > bestValue) {
      bestValue = value;
      best = action;
    }
  }
  return { action: best, explanation: explain(board, rules, state, snapshot, best) };
}

/** States the facts the mock's evaluation actually used. It never claims more than that. */
function explain(board: Board, rules: RulesConfig, state: GameState, snap: Snapshot, action: Action): string {
  switch (action.type) {
    case "fire":
      return `Enemy is visible at range ${snap.enemy.distance}; firing for ${snap.fire.expectedDamage}${snap.fire.enemyCover ? " through its cover" : ""}.`;
    case "brace":
      return snap.enemyThreat.canFireAtYouNow
        ? `Enemy can hit me from where it stands; bracing cuts the next hit to ${Math.max(rules.minDamage, (snap.enemyThreat.expectedDamageIfYouStay ?? 0) - rules.braceReduction)}.`
        : "Holding position and bracing in case the enemy steps into view.";
    case "overwatch":
      return snap.enemy.distance <= rules.fireRange + rules.moveRange
        ? "Enemy is close but out of sight; covering the tiles it would have to step onto."
        : "Covering the approach lanes with overwatch.";
    case "move": {
      const option = snap.moves.find((m) => sameCoord(m.to, action.to));
      const uplink = board.uplinks.find((u) => sameCoord(u.at, action.to));
      const parts: string[] = [];
      if (uplink && state.owners[uplink.id] !== state.active) parts.push(`taking the ${uplink.name}`);
      if (option?.canFireAtEnemyFromHere) parts.push("setting up a shot");
      if (option && !option.enemyCanFireHere) parts.push("staying out of the enemy's sight");
      else if (option?.coverFromEnemy) parts.push("using the barrier for cover");
      return `Moving to ${coordKey(action.to)}${parts.length ? `: ${parts.join(", ")}` : ""}.`;
    }
  }
}

/** Reply text exactly as a well-behaved model would send it. */
export function mockReply(decision: MockDecision): string {
  return JSON.stringify({ ...decision.action, explanation: decision.explanation });
}

/** For the glitch persona: a broken reply on some first attempts, so retries are visible in real matches. */
export function glitchReply(state: GameState, attempt: number): string | null {
  if (attempt > 0 || state.turn % 3 !== 0) return null;
  return state.turn % 2 === 0 ? "Let me think about this... I'll go with the flanking manoeuvre!" : JSON.stringify({ action: "move", to: [-1, 99], explanation: "Teleporting." });
}
