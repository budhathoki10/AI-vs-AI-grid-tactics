/** Core data types shared by the engine, the server and the client. Everything here is plain JSON. */

export type Side = "A" | "B";
export const SIDES: readonly Side[] = ["A", "B"];
export const otherSide = (side: Side): Side => (side === "A" ? "B" : "A");

/** [x, y] — x grows to the east (columns), y grows to the south (rows). */
export type Coord = readonly [number, number];

export type TileKind = "floor" | "wall" | "barrier" | "uplink";

export interface UplinkDef {
  id: string;
  name: string;
  at: Coord;
  /** Points awarded to the owner at the end of each of the owner's turns. */
  value: number;
}

export interface MapDef {
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  /** Row strings, one char per tile: '.' floor, '#' wall, '=' barrier, 'U' uplink, 'P' prime uplink, 'A'/'B' start (floor). */
  rows: readonly string[];
}

export interface Board {
  mapId: string;
  width: number;
  height: number;
  /** tiles[y][x] */
  tiles: TileKind[][];
  uplinks: UplinkDef[];
  starts: Record<Side, Coord>;
}

export interface RobotState {
  side: Side;
  pos: Coord;
  hp: number;
  /** Damage reduction active until the start of this robot's next turn. */
  braced: boolean;
  /** Reaction shot armed until the start of this robot's next turn. */
  overwatch: boolean;
  /** Used Brace or Overwatch last turn: this turn it must Move or Fire. */
  recharging: boolean;
  score: number;
}

export type GameOverReason = "disabled" | "score" | "turn-limit" | "stopped";

export interface GameResult {
  winner: Side | null;
  reason: GameOverReason;
  /** Human-readable, exact explanation of why the match ended. */
  detail: string;
}

export interface GameState {
  /** 1-based count of the action about to be taken. */
  turn: number;
  active: Side;
  robots: Record<Side, RobotState>;
  /** uplink id -> owner */
  owners: Record<string, Side | null>;
  result: GameResult | null;
}

export type Action =
  | { type: "move"; to: Coord }
  | { type: "fire" }
  | { type: "brace" }
  | { type: "overwatch" };

export type ActionType = Action["type"];

/** Observable consequences of one action, in the order they happened. Used for animation, logs and replays. */
export type GameEvent =
  | { kind: "moved"; side: Side; path: Coord[] }
  | { kind: "fired"; side: Side; target: Side; damage: number; modifiers: string[]; reaction: boolean }
  | { kind: "braced"; side: Side }
  | { kind: "overwatch-set"; side: Side; watched: Coord[] }
  | { kind: "overwatch-expired"; side: Side }
  | { kind: "captured"; side: Side; uplinkId: string; from: Side | null }
  | { kind: "scored"; side: Side; points: number; total: number }
  | { kind: "disabled"; side: Side }
  | { kind: "game-over"; result: GameResult };

export interface RulesConfig {
  maxHp: number;
  moveRange: number;
  fireRange: number;
  fireDamage: number;
  overwatchDamage: number;
  coverReduction: number;
  braceReduction: number;
  minDamage: number;
  scoreToWin: number;
  /** Total actions in the match (both robots combined). */
  turnLimit: number;
}
