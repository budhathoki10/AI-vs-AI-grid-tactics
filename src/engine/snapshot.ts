import { checkFire, computeDamage, describeAction, legalActions, moveOptions, stancesAvailable } from "./engine";
import { coordKey, sameCoord } from "./geometry";
import { rulesSummary } from "./rules";
import { otherSide, type Action, type Board, type Coord, type GameEvent, type GameState, type RulesConfig, type Side } from "./types";

/** One line of history as the models see it. */
export interface HistoryLine {
  turn: number;
  side: Side;
  action: Action;
  events: GameEvent[];
}

export interface MoveOption {
  action: "move";
  to: Coord;
  steps: number;
  uplink?: string;
  /** Could the enemy, from where it stands now, fire at this tile on its next turn? */
  enemyCanFireHere: boolean;
  /** If it could, would a barrier give you cover? */
  coverFromEnemy: boolean;
  /** Could you fire at the enemy from here next turn (if it stays put)? */
  canFireAtEnemyFromHere: boolean;
  /** Ending here would trigger the enemy's armed overwatch. */
  triggersEnemyOverwatch: boolean;
}

export interface Snapshot {
  game: "Uplink Duel";
  you: Side;
  turn: number;
  turnLimit: number;
  turnsLeftForYou: number;
  board: { width: number; height: number; legend: string; rows: string[] };
  self: { pos: Coord; hp: number; maxHp: number; score: number; braced: boolean; overwatch: boolean; stancesRecharging: boolean };
  enemy: { pos: Coord; hp: number; maxHp: number; score: number; braced: boolean; overwatch: boolean; distance: number };
  scoreToWin: number;
  uplinks: { id: string; name: string; at: Coord; value: number; owner: "you" | "enemy" | "nobody" }[];
  incomePerTurn: { you: number; enemy: number };
  fire: { available: boolean; reason: string; expectedDamage: number | null; enemyCover: boolean };
  enemyThreat: { canFireAtYouNow: boolean; expectedDamageIfYouStay: number | null };
  moves: MoveOption[];
  otherActions: string[];
  recentHistory: string[];
}

const LEGEND = "Y = you, E = enemy, # wall (blocks movement and sight), = barrier (blocks movement, gives cover, does not block sight), P = prime uplink (2 pts), U = uplink (1 pt), . floor. Coordinates are [x, y]: x is the column (0 = left), y is the row (0 = top).";

function boardRows(board: Board, state: GameState, side: Side): string[] {
  const me = state.robots[side].pos;
  const foe = state.robots[otherSide(side)].pos;
  const header = "    " + Array.from({ length: board.width }, (_, x) => String(x)).join(" ");
  const rows = [header];
  for (let y = 0; y < board.height; y++) {
    const cells: string[] = [];
    for (let x = 0; x < board.width; x++) {
      const c: Coord = [x, y];
      if (sameCoord(c, me)) cells.push("Y");
      else if (sameCoord(c, foe)) cells.push("E");
      else {
        const tile = board.tiles[y][x];
        if (tile === "wall") cells.push("#");
        else if (tile === "barrier") cells.push("=");
        else if (tile === "uplink") cells.push(board.uplinks.find((u) => sameCoord(u.at, c))!.value > 1 ? "P" : "U");
        else cells.push(".");
      }
    }
    rows.push(`y=${y} ${cells.join(" ")}`);
  }
  return rows;
}

export function describeEvents(events: GameEvent[], viewer?: Side): string {
  const who = (s: Side) => (viewer ? (s === viewer ? "you" : "enemy") : `Robot ${s}`);
  const parts: string[] = [];
  for (const e of events) {
    switch (e.kind) {
      case "moved":
        parts.push(`${who(e.side)} moved ${coordKey(e.path[0])} → ${coordKey(e.path[e.path.length - 1])}`);
        break;
      case "fired":
        parts.push(`${e.reaction ? "overwatch: " : ""}${who(e.side)} hit ${who(e.target)} for ${e.damage}${e.modifiers.length ? ` (${e.modifiers.join(", ")})` : ""}`);
        break;
      case "braced":
        parts.push(`${who(e.side)} braced`);
        break;
      case "overwatch-set":
        parts.push(`${who(e.side)} armed overwatch over ${e.watched.length} tiles`);
        break;
      case "captured":
        parts.push(`${who(e.side)} captured an uplink${e.from ? ` from ${who(e.from)}` : ""}`);
        break;
      case "scored":
        parts.push(`${who(e.side)} +${e.points} pts (total ${e.total})`);
        break;
      case "disabled":
        parts.push(`${who(e.side)} disabled`);
        break;
      default:
        break;
    }
  }
  return parts.join("; ");
}

export function buildSnapshot(board: Board, rules: RulesConfig, state: GameState, history: HistoryLine[]): Snapshot {
  const side = state.active;
  const foe = otherSide(side);
  const me = state.robots[side];
  const enemy = state.robots[foe];
  const owner = (id: string) => (state.owners[id] === side ? "you" : state.owners[id] === foe ? "enemy" : "nobody");
  const income = (s: Side) => board.uplinks.reduce((sum, u) => (state.owners[u.id] === s ? sum + u.value : sum), 0);

  const myFire = checkFire(board, rules, me.pos, enemy.pos);
  const fireReason = myFire.canHit
    ? myFire.cover
      ? "enemy is in range and visible, but in cover"
      : "enemy is in range and visible"
    : !myFire.inRange
      ? `enemy is out of range (${Math.max(Math.abs(me.pos[0] - enemy.pos[0]), Math.abs(me.pos[1] - enemy.pos[1]))} > ${rules.fireRange})`
      : "a wall blocks line of sight";

  const threat = checkFire(board, rules, enemy.pos, me.pos);
  const unbraced = { ...me, braced: false };

  const moves: MoveOption[] = [...moveOptions(board, rules, state, side).values()]
    .map((path): MoveOption => {
      const to = path[path.length - 1];
      const enemyShot = checkFire(board, rules, enemy.pos, to);
      const myShot = checkFire(board, rules, to, enemy.pos);
      const uplink = board.uplinks.find((u) => sameCoord(u.at, to));
      return {
        action: "move",
        to,
        steps: path.length - 1,
        ...(uplink ? { uplink: `${uplink.name} (${uplink.value} pt${uplink.value > 1 ? "s" : ""}, owner: ${owner(uplink.id)})` } : {}),
        enemyCanFireHere: enemyShot.canHit,
        coverFromEnemy: enemyShot.canHit && enemyShot.cover,
        canFireAtEnemyFromHere: myShot.canHit,
        triggersEnemyOverwatch: enemy.overwatch && enemyShot.canHit,
      };
    })
    .sort((a, b) => a.to[1] - b.to[1] || a.to[0] - b.to[0]);

  const turnsLeftTotal = rules.turnLimit - state.turn + 1;

  return {
    game: "Uplink Duel",
    you: side,
    turn: state.turn,
    turnLimit: rules.turnLimit,
    turnsLeftForYou: Math.ceil(turnsLeftTotal / 2),
    board: { width: board.width, height: board.height, legend: LEGEND, rows: boardRows(board, state, side) },
    self: { pos: me.pos, hp: me.hp, maxHp: rules.maxHp, score: me.score, braced: me.braced, overwatch: me.overwatch, stancesRecharging: !stancesAvailable(board, rules, state) },
    enemy: {
      pos: enemy.pos,
      hp: enemy.hp,
      maxHp: rules.maxHp,
      score: enemy.score,
      braced: enemy.braced,
      overwatch: enemy.overwatch,
      distance: Math.max(Math.abs(me.pos[0] - enemy.pos[0]), Math.abs(me.pos[1] - enemy.pos[1])),
    },
    scoreToWin: rules.scoreToWin,
    uplinks: board.uplinks.map((u) => ({ id: u.id, name: u.name, at: u.at, value: u.value, owner: owner(u.id) })),
    incomePerTurn: { you: income(side), enemy: income(foe) },
    fire: {
      available: myFire.canHit,
      reason: fireReason,
      expectedDamage: myFire.canHit ? computeDamage(rules, rules.fireDamage, enemy, myFire.cover).damage : null,
      enemyCover: myFire.cover,
    },
    enemyThreat: {
      canFireAtYouNow: threat.canHit,
      expectedDamageIfYouStay: threat.canHit ? computeDamage(rules, rules.fireDamage, unbraced, threat.cover).damage : null,
    },
    moves,
    otherActions: legalActions(board, rules, state)
      .filter((a) => a.type !== "move")
      .map((a) => a.type),
    recentHistory: history.slice(-10).map((h) => `T${h.turn} ${h.side === side ? "you" : "enemy"}: ${describeAction(h.action)} — ${describeEvents(h.events, side) || "no effect"}`),
  };
}

export const SYSTEM_PROMPT =
  "You control one combat robot in Uplink Duel, a deterministic turn-based tactics game against another AI. " +
  "Think about positioning, cover, the opponent's likely reply, and the uplink score race. " +
  "Answer with a single JSON object and nothing else.";

export function buildPrompt(rules: RulesConfig, snapshot: Snapshot, previousError?: string): string {
  const lines = [
    `You are Robot ${snapshot.you}. It is turn ${snapshot.turn} of ${snapshot.turnLimit}. You have ${snapshot.turnsLeftForYou} action(s) left including this one.`,
    "",
    "RULES",
    ...rulesSummary(rules).map((r) => `- ${r}`),
    "",
    "CURRENT STATE (JSON)",
    JSON.stringify(
      {
        self: snapshot.self,
        enemy: snapshot.enemy,
        scoreToWin: snapshot.scoreToWin,
        incomePerTurn: snapshot.incomePerTurn,
        uplinks: snapshot.uplinks,
        fire: snapshot.fire,
        enemyThreat: snapshot.enemyThreat,
        recentHistory: snapshot.recentHistory,
      },
      null,
      0,
    ),
    "",
    "MAP",
    snapshot.board.legend,
    ...snapshot.board.rows,
    "",
    "LEGAL MOVE DESTINATIONS (facts computed by the engine)",
    ...snapshot.moves.map(
      (m) =>
        `- [${m.to[0]},${m.to[1]}] steps=${m.steps}${m.uplink ? ` uplink=${m.uplink}` : ""} enemyCanFireHere=${m.enemyCanFireHere}${m.coverFromEnemy ? " (cover)" : ""} canFireAtEnemyFromHere=${m.canFireAtEnemyFromHere}${m.triggersEnemyOverwatch ? " TRIGGERS_ENEMY_OVERWATCH" : ""}`,
    ),
    `OTHER LEGAL ACTIONS: ${snapshot.otherActions.join(", ")}`,
    "",
    "Reply with ONLY one JSON object, no markdown, in one of these shapes:",
    '{"action":"move","to":[x,y],"explanation":"<one or two short sentences for viewers>"}',
    '{"action":"fire","explanation":"..."}',
    '{"action":"brace","explanation":"..."}',
    '{"action":"overwatch","explanation":"..."}',
  ];
  if (previousError) lines.push("", `Your previous reply was rejected: ${previousError}. Choose one of the legal actions listed above.`);
  return lines.join("\n");
}
