import { allTiles, chebyshev, coordKey, hasLineOfSight, isInCover, isPassable, reachableTiles, sameCoord, tileAt } from "./geometry";
import {
  otherSide,
  type Action,
  type Board,
  type Coord,
  type GameEvent,
  type GameResult,
  type GameState,
  type RobotState,
  type RulesConfig,
  type Side,
} from "./types";

export interface FireCheck {
  inRange: boolean;
  lineOfSight: boolean;
  cover: boolean;
  canHit: boolean;
}

export function checkFire(board: Board, rules: RulesConfig, from: Coord, to: Coord): FireCheck {
  const inRange = chebyshev(from, to) <= rules.fireRange;
  const lineOfSight = inRange && hasLineOfSight(board, from, to);
  const cover = lineOfSight && isInCover(board, from, to);
  return { inRange, lineOfSight, cover, canHit: inRange && lineOfSight };
}

export interface DamageResult {
  damage: number;
  modifiers: string[];
}

export function computeDamage(rules: RulesConfig, base: number, target: RobotState, cover: boolean): DamageResult {
  const modifiers: string[] = [];
  let damage = base;
  if (cover) {
    damage -= rules.coverReduction;
    modifiers.push("cover");
  }
  if (target.braced) {
    damage -= rules.braceReduction;
    modifiers.push("braced");
  }
  if (damage < rules.minDamage) {
    damage = rules.minDamage;
    modifiers.push("minimum");
  }
  return { damage, modifiers };
}

export function createInitialState(board: Board, rules: RulesConfig, firstSide: Side = "A"): GameState {
  const robot = (side: Side): RobotState => ({ side, pos: board.starts[side], hp: rules.maxHp, braced: false, overwatch: false, recharging: false, score: 0 });
  return {
    turn: 1,
    active: firstSide,
    robots: { A: robot("A"), B: robot("B") },
    owners: Object.fromEntries(board.uplinks.map((u) => [u.id, null])),
    result: null,
  };
}

export function cloneState(state: GameState): GameState {
  return {
    turn: state.turn,
    active: state.active,
    robots: { A: { ...state.robots.A }, B: { ...state.robots.B } },
    owners: { ...state.owners },
    result: state.result ? { ...state.result } : null,
  };
}

/** Tiles the given robot could move to right now, with their paths. */
export function moveOptions(board: Board, rules: RulesConfig, state: GameState, side: Side): Map<string, Coord[]> {
  return reachableTiles(board, state.robots[side].pos, rules.moveRange, state.robots[otherSide(side)].pos);
}

/** Every legal action for the active robot, in a stable order. */
export function legalActions(board: Board, rules: RulesConfig, state: GameState): Action[] {
  if (state.result) return [];
  const side = state.active;
  const me = state.robots[side];
  const enemy = state.robots[otherSide(side)];
  const actions: Action[] = [];
  const moves = [...moveOptions(board, rules, state, side).values()].map((path) => path[path.length - 1]);
  moves.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  for (const to of moves) actions.push({ type: "move", to });
  if (checkFire(board, rules, me.pos, enemy.pos).canHit) actions.push({ type: "fire" });
  if (stancesAvailable(board, rules, state)) actions.push({ type: "brace" }, { type: "overwatch" });
  return actions;
}

/**
 * Brace and Overwatch need a turn to recharge: after using one, the robot must Move or Fire next.
 * If it is boxed in with nothing to move to or shoot at, stances stay available so a legal action always exists.
 */
export function stancesAvailable(board: Board, rules: RulesConfig, state: GameState): boolean {
  const me = state.robots[state.active];
  if (!me.recharging) return true;
  const enemy = state.robots[otherSide(state.active)];
  return moveOptions(board, rules, state, state.active).size === 0 && !checkFire(board, rules, me.pos, enemy.pos).canHit;
}

export type Validation = { ok: true; action: Action } | { ok: false; reason: string };

/** The single source of truth for legality. Model output is never trusted to be legal. */
export function validateAction(board: Board, rules: RulesConfig, state: GameState, side: Side, action: Action): Validation {
  if (state.result) return { ok: false, reason: "the match is already over" };
  if (side !== state.active) return { ok: false, reason: `it is Robot ${state.active}'s turn, not Robot ${side}'s` };
  const me = state.robots[side];
  const enemy = state.robots[otherSide(side)];
  switch (action.type) {
    case "move": {
      const to = action.to;
      if (!Array.isArray(to) || to.length !== 2 || !to.every((n) => Number.isInteger(n))) return { ok: false, reason: "move needs integer coordinates [x, y]" };
      const tile = tileAt(board, to);
      if (tile === null) return { ok: false, reason: `tile ${coordKey(to)} is off the board` };
      if (sameCoord(to, me.pos)) return { ok: false, reason: `you are already on ${coordKey(to)}; a move must change tile` };
      if (sameCoord(to, enemy.pos)) return { ok: false, reason: `tile ${coordKey(to)} is occupied by the enemy robot` };
      if (!isPassable(board, to)) return { ok: false, reason: `tile ${coordKey(to)} is a ${tile} and cannot be entered` };
      if (!moveOptions(board, rules, state, side).has(coordKey(to)))
        return { ok: false, reason: `tile ${coordKey(to)} is not reachable within ${rules.moveRange} orthogonal steps` };
      return { ok: true, action: { type: "move", to: [to[0], to[1]] } };
    }
    case "fire": {
      const check = checkFire(board, rules, me.pos, enemy.pos);
      if (!check.inRange) return { ok: false, reason: `the enemy is ${chebyshev(me.pos, enemy.pos)} tiles away; fire range is ${rules.fireRange}` };
      if (!check.lineOfSight) return { ok: false, reason: "a wall blocks line of sight to the enemy" };
      return { ok: true, action: { type: "fire" } };
    }
    case "brace":
    case "overwatch":
      if (!stancesAvailable(board, rules, state)) return { ok: false, reason: `${action.type} is recharging: you used a stance last turn, so this turn you must move or fire` };
      return { ok: true, action: { type: action.type } };
    default:
      return { ok: false, reason: `unknown action "${(action as { type?: unknown }).type}"` };
  }
}

/** Tiles an overwatching robot covers: passable tiles within range and sight. */
export function watchedTiles(board: Board, rules: RulesConfig, from: Coord): Coord[] {
  return allTiles(board).filter((c) => !sameCoord(c, from) && isPassable(board, c) && checkFire(board, rules, from, c).canHit);
}

export interface ApplyResult {
  state: GameState;
  events: GameEvent[];
}

/**
 * Applies one validated action and resolves every rule consequence in a fixed order:
 * expire own stances → action → overwatch reaction → disable check → capture → scoring → turn limit.
 * Pure: the input state is never mutated.
 */
export function applyAction(board: Board, rules: RulesConfig, input: GameState, action: Action): ApplyResult {
  const check = validateAction(board, rules, input, input.active, action);
  if (!check.ok) throw new Error(`Illegal action: ${check.reason}`);
  const state = cloneState(input);
  const side = state.active;
  const foe = otherSide(side);
  const me = state.robots[side];
  const enemy = state.robots[foe];
  const events: GameEvent[] = [];

  me.braced = false;
  if (me.overwatch) {
    me.overwatch = false;
    events.push({ kind: "overwatch-expired", side });
  }

  const finish = (result: GameResult): ApplyResult => {
    state.result = result;
    events.push({ kind: "game-over", result });
    return { state, events };
  };

  const act = check.action;
  me.recharging = act.type === "brace" || act.type === "overwatch";
  switch (act.type) {
    case "move": {
      const path = moveOptions(board, rules, input, side).get(coordKey(act.to))!;
      me.pos = act.to;
      events.push({ kind: "moved", side, path });
      if (enemy.overwatch) {
        const shot = checkFire(board, rules, enemy.pos, me.pos);
        if (shot.canHit) {
          const { damage, modifiers } = computeDamage(rules, rules.overwatchDamage, me, shot.cover);
          me.hp = Math.max(0, me.hp - damage);
          enemy.overwatch = false;
          events.push({ kind: "fired", side: foe, target: side, damage, modifiers, reaction: true });
          if (me.hp === 0) {
            events.push({ kind: "disabled", side });
            return finish({ winner: foe, reason: "disabled", detail: `Robot ${side} moved into Robot ${foe}'s overwatch and was disabled` });
          }
        }
      }
      break;
    }
    case "fire": {
      const shot = checkFire(board, rules, me.pos, enemy.pos);
      const { damage, modifiers } = computeDamage(rules, rules.fireDamage, enemy, shot.cover);
      enemy.hp = Math.max(0, enemy.hp - damage);
      events.push({ kind: "fired", side, target: foe, damage, modifiers, reaction: false });
      if (enemy.hp === 0) {
        events.push({ kind: "disabled", side: foe });
        return finish({ winner: side, reason: "disabled", detail: `Robot ${side} disabled Robot ${foe} with a direct hit` });
      }
      break;
    }
    case "brace":
      me.braced = true;
      events.push({ kind: "braced", side });
      break;
    case "overwatch":
      me.overwatch = true;
      events.push({ kind: "overwatch-set", side, watched: watchedTiles(board, rules, me.pos) });
      break;
  }

  const uplink = board.uplinks.find((u) => sameCoord(u.at, me.pos));
  if (uplink && state.owners[uplink.id] !== side) {
    events.push({ kind: "captured", side, uplinkId: uplink.id, from: state.owners[uplink.id] });
    state.owners[uplink.id] = side;
  }

  const points = board.uplinks.reduce((sum, u) => (state.owners[u.id] === side ? sum + u.value : sum), 0);
  if (points > 0) {
    me.score += points;
    events.push({ kind: "scored", side, points, total: me.score });
    if (me.score >= rules.scoreToWin) {
      return finish({ winner: side, reason: "score", detail: `Robot ${side} reached ${me.score} points (target ${rules.scoreToWin})` });
    }
  }

  const completed = state.turn;
  state.turn += 1;
  state.active = foe;
  if (completed >= rules.turnLimit) return finish(turnLimitResult(state, rules));
  return { state, events };
}

export function turnLimitResult(state: GameState, rules: RulesConfig): GameResult {
  const { A, B } = state.robots;
  const prefix = `Turn limit (${rules.turnLimit} actions) reached`;
  if (A.score !== B.score) {
    const winner: Side = A.score > B.score ? "A" : "B";
    return { winner, reason: "turn-limit", detail: `${prefix}: Robot ${winner} leads on points ${Math.max(A.score, B.score)}–${Math.min(A.score, B.score)}` };
  }
  if (A.hp !== B.hp) {
    const winner: Side = A.hp > B.hp ? "A" : "B";
    return { winner, reason: "turn-limit", detail: `${prefix}: points tied at ${A.score}, Robot ${winner} has more HP (${Math.max(A.hp, B.hp)} vs ${Math.min(A.hp, B.hp)})` };
  }
  return { winner: null, reason: "turn-limit", detail: `${prefix} with points tied at ${A.score} and HP tied at ${A.hp}: draw` };
}

export function describeAction(action: Action): string {
  switch (action.type) {
    case "move":
      return `move to ${coordKey(action.to)}`;
    case "fire":
      return "fire";
    case "brace":
      return "brace";
    case "overwatch":
      return "overwatch";
  }
}

/**
 * The action the engine takes for a model that produced nothing usable: brace if allowed, otherwise
 * the first move that leaves the enemy's sight, otherwise fire, otherwise any move. Deterministic.
 */
export function fallbackAction(board: Board, rules: RulesConfig, state: GameState): Action {
  const actions = legalActions(board, rules, state);
  if (actions.some((a) => a.type === "brace")) return { type: "brace" };
  const enemy = state.robots[otherSide(state.active)];
  const hidden = actions.find((a) => a.type === "move" && !checkFire(board, rules, enemy.pos, a.to).canHit);
  return hidden ?? actions.find((a) => a.type === "fire") ?? actions[0];
}
