import { describe, expect, it } from "vitest";
import { applyAction, checkFire, createInitialState, fallbackAction, legalActions, validateAction, watchedTiles } from "./engine";
import { hasLineOfSight, isInCover, reachableTiles } from "./geometry";
import { buildBoard, getMap, MAPS } from "./maps";
import { DEFAULT_RULES } from "./rules";
import type { Board, Coord, GameState, MapDef, RulesConfig } from "./types";

const rules: RulesConfig = { ...DEFAULT_RULES };

/** Builds a board from rows; missing start markers go in the top-left / bottom-right corners. */
function testMap(input: string[]): Board {
  const rows = [...input];
  if (!rows.join("").includes("A")) rows[0] = "A" + rows[0].slice(1);
  if (!rows.join("").includes("B")) rows[rows.length - 1] = rows[rows.length - 1].slice(0, -1) + "B";
  const map: MapDef = { id: "test", name: "Test", description: "", width: rows[0].length, height: rows.length, rows };
  return buildBoard(map);
}

/** Puts both robots on the given tiles with A to act. */
function placed(board: Board, a: Coord, b: Coord, patch: (s: GameState) => void = () => {}): GameState {
  const s = createInitialState(board, rules, "A");
  s.robots.A.pos = a;
  s.robots.B.pos = b;
  patch(s);
  return s;
}

describe("maps", () => {
  it.each(MAPS.map((m) => [m.id]))("%s is point-symmetric so neither start is favoured", (id) => {
    const map = getMap(id);
    const flip = (c: string) => (c === "A" ? "B" : c === "B" ? "A" : c);
    for (let y = 0; y < map.height; y++)
      for (let x = 0; x < map.width; x++) expect(flip(map.rows[map.height - 1 - y][map.width - 1 - x])).toBe(map.rows[y][x]);
  });

  it("swapping starts trades the robots' tiles", () => {
    const normal = buildBoard(MAPS[0]);
    const swapped = buildBoard(MAPS[0], true);
    expect(swapped.starts.A).toEqual(normal.starts.B);
    expect(swapped.starts.B).toEqual(normal.starts.A);
  });

  it("names a prime uplink worth 2 and flanks worth 1", () => {
    const board = buildBoard(MAPS[0]);
    expect(board.uplinks.map((u) => [u.id, u.value])).toEqual([
      ["prime", 2],
      ["west", 1],
      ["east", 1],
    ]);
  });
});

describe("movement", () => {
  const board = testMap([".....", ".#...", ".=...", ".....", "A...B"]);

  it("reaches tiles within range by orthogonal steps, around walls and barriers", () => {
    const tiles = reachableTiles(board, [0, 4], 2, [4, 4]);
    expect(tiles.has("2,4")).toBe(true);
    expect(tiles.has("1,3")).toBe(true);
    expect(tiles.has("1,2")).toBe(false); // barrier
    expect(tiles.has("3,4")).toBe(false); // 3 steps
  });

  it("rejects moves onto walls, barriers, the enemy, off-board, out of range, or staying put", () => {
    const s = placed(board, [0, 3], [1, 3]);
    const bad: [Coord, RegExp][] = [
      [[1, 1], /wall|reachable/],
      [[1, 2], /barrier/],
      [[1, 3], /occupied/],
      [[-1, 3], /off the board/],
      [[0, 0], /not reachable/],
      [[0, 3], /already on/],
    ];
    for (const [to, reason] of bad) {
      const v = validateAction(board, rules, s, "A", { type: "move", to });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(reason);
    }
    expect(validateAction(board, rules, s, "A", { type: "move", to: [0, 1] }).ok).toBe(true);
  });

  it("cannot walk through the other robot", () => {
    const corridor = testMap(["#####", "A.B..", "#####"]);
    const s = placed(corridor, [0, 1], [1, 1]);
    expect(validateAction(corridor, rules, s, "A", { type: "move", to: [2, 1] }).ok).toBe(false);
  });

  it("rejects non-integer coordinates", () => {
    const s = placed(board, [0, 4], [4, 4]);
    expect(validateAction(board, rules, s, "A", { type: "move", to: [0.5, 4] }).ok).toBe(false);
  });
});

describe("line of sight and cover", () => {
  it("walls block sight, barriers do not", () => {
    const board = testMap([".....", "A.#.B", "..=..", "....."]);
    expect(hasLineOfSight(board, [0, 1], [4, 1])).toBe(false);
    expect(hasLineOfSight(board, [0, 2], [4, 2])).toBe(true);
  });

  it("grazing a single wall corner does not block, a diagonal wall pinch does", () => {
    const graze = testMap([".#.", "...", "..."]);
    expect(hasLineOfSight(graze, [0, 0], [2, 2])).toBe(true);
    const pinch = testMap(["A#.", "#..", "..."]);
    expect(hasLineOfSight(pinch, [0, 0], [1, 1])).toBe(false);
    expect(hasLineOfSight(pinch, [0, 0], [2, 2])).toBe(false);
  });

  it("a barrier next to the target on the line of fire gives cover", () => {
    const board = testMap(["A..=B"]);
    expect(isInCover(board, [0, 0], [4, 0])).toBe(true);
    const far = testMap(["A=..B"]);
    expect(isInCover(far, [0, 0], [4, 0])).toBe(false);
  });

  it("fire range is Chebyshev distance", () => {
    const board = testMap(["......", "......", "......", "......", "......", "......"]);
    expect(checkFire(board, rules, [0, 0], [4, 4]).inRange).toBe(true);
    expect(checkFire(board, rules, [0, 0], [5, 1]).inRange).toBe(false);
  });
});

describe("actions", () => {
  const open = testMap([".......", ".......", "......."]);

  it("fire is only legal with range and sight", () => {
    const blocked = testMap(["A.#.B"]);
    const s = placed(blocked, [0, 0], [4, 0]);
    expect(legalActions(blocked, rules, s).some((a) => a.type === "fire")).toBe(false);
    expect(validateAction(blocked, rules, s, "A", { type: "fire" })).toMatchObject({ ok: false, reason: expect.stringMatching(/wall/) });
  });

  it("fire deals base damage, minus cover, minus brace, never below the minimum", () => {
    const s = placed(open, [0, 1], [3, 1]);
    const hit = applyAction(open, rules, s, { type: "fire" });
    expect(hit.state.robots.B.hp).toBe(rules.maxHp - rules.fireDamage);

    const covered = testMap(["A.=B"]);
    const braced = placed(covered, [0, 0], [3, 0], (st) => (st.robots.B.braced = true));
    const res = applyAction(covered, rules, braced, { type: "fire" });
    const fired = res.events.find((e) => e.kind === "fired");
    expect(fired).toMatchObject({ damage: rules.minDamage, modifiers: ["cover", "braced", "minimum"] });
  });

  it("brace and overwatch expire at the start of the robot's own next turn", () => {
    let s = placed(open, [0, 0], [6, 2]);
    s = applyAction(open, rules, s, { type: "brace" }).state;
    expect(s.robots.A.braced).toBe(true);
    s = applyAction(open, rules, s, { type: "overwatch" }).state; // B
    s = applyAction(open, rules, s, { type: "move", to: [1, 0] }).state; // A acts: brace drops
    expect(s.robots.A.braced).toBe(false);
    const res = applyAction(open, rules, s, { type: "move", to: [6, 1] }); // B acts: its overwatch expires
    expect(res.state.robots.B.overwatch).toBe(false);
    expect(res.events[0]).toEqual({ kind: "overwatch-expired", side: "B" });
  });

  it("stances recharge: after brace or overwatch the next action must be move or fire", () => {
    let s = placed(open, [0, 0], [6, 2]);
    s = applyAction(open, rules, s, { type: "brace" }).state;
    s = applyAction(open, rules, s, { type: "move", to: [5, 2] }).state;
    expect(legalActions(open, rules, s).some((a) => a.type === "brace" || a.type === "overwatch")).toBe(false);
    expect(validateAction(open, rules, s, "A", { type: "overwatch" })).toMatchObject({ ok: false, reason: expect.stringMatching(/recharging/) });
    s = applyAction(open, rules, s, { type: "move", to: [1, 0] }).state;
    s = applyAction(open, rules, s, { type: "move", to: [5, 1] }).state;
    expect(validateAction(open, rules, s, "A", { type: "overwatch" }).ok).toBe(true);
  });

  it("a boxed-in recharging robot may still use a stance, so a legal action always exists", () => {
    const box = testMap(["#####", "#A#B#", "#####"]);
    const s = placed(box, [1, 1], [3, 1], (st) => (st.robots.A.recharging = true));
    expect(legalActions(box, rules, s)).toEqual([{ type: "brace" }, { type: "overwatch" }]);
    expect(fallbackAction(box, rules, s)).toEqual({ type: "brace" });
  });

  it("the fallback for a recharging robot is a move out of sight", () => {
    const s = placed(open, [3, 1], [6, 1], (st) => (st.robots.A.recharging = true));
    const fb = fallbackAction(open, rules, s);
    expect(fb.type).toBe("move");
  });

  it("overwatch hits a robot that ends its move in sight, once", () => {
    let s = placed(open, [0, 0], [6, 0], (st) => {
      st.active = "B";
    });
    s = applyAction(open, rules, s, { type: "overwatch" }).state;
    expect(watchedTiles(open, rules, [6, 0]).length).toBeGreaterThan(0);
    const res = applyAction(open, rules, s, { type: "move", to: [2, 0] });
    expect(res.events).toContainEqual({ kind: "fired", side: "B", target: "A", damage: rules.overwatchDamage, modifiers: [], reaction: true });
    expect(res.state.robots.A.hp).toBe(rules.maxHp - rules.overwatchDamage);
    expect(res.state.robots.B.overwatch).toBe(false);
  });

  it("overwatch does not fire at a move that ends out of sight", () => {
    const walled = testMap(["A...#.B", "....#.."]);
    let s = placed(walled, [0, 0], [6, 0], (st) => (st.active = "B"));
    s = applyAction(walled, rules, s, { type: "overwatch" }).state;
    const res = applyAction(walled, rules, s, { type: "move", to: [1, 1] });
    expect(res.events.some((e) => e.kind === "fired")).toBe(false);
    expect(res.state.robots.B.overwatch).toBe(true);
  });

  it("never mutates the input state", () => {
    const s = placed(open, [0, 1], [3, 1]);
    const before = JSON.stringify(s);
    applyAction(open, rules, s, { type: "fire" });
    expect(JSON.stringify(s)).toBe(before);
  });

  it("refuses to apply an action for the wrong side or after the match ended", () => {
    const s = placed(open, [0, 1], [3, 1]);
    expect(validateAction(open, rules, s, "B", { type: "brace" }).ok).toBe(false);
    const over = { ...s, result: { winner: "A" as const, reason: "score" as const, detail: "" } };
    expect(() => applyAction(open, rules, over, { type: "brace" })).toThrow(/over/);
  });
});

describe("state progression between turns", () => {
  it("alternates the active robot and counts turns", () => {
    const board = buildBoard(MAPS[0]);
    let s = createInitialState(board, rules, "B");
    expect(s.active).toBe("B");
    s = applyAction(board, rules, s, { type: "brace" }).state;
    expect(s).toMatchObject({ active: "A", turn: 2 });
    s = applyAction(board, rules, s, { type: "brace" }).state;
    expect(s).toMatchObject({ active: "B", turn: 3 });
  });
});

describe("uplinks, scoring and match end", () => {
  const board = testMap(["AU..P..B"]);

  it("ending on an uplink captures it and scores its value at the end of each own turn", () => {
    let s = placed(board, [0, 0], [7, 0]);
    let res = applyAction(board, rules, s, { type: "move", to: [1, 0] });
    expect(res.events).toContainEqual({ kind: "captured", side: "A", uplinkId: "west", from: null });
    expect(res.events).toContainEqual({ kind: "scored", side: "A", points: 1, total: 1 });
    s = res.state;
    s = applyAction(board, rules, s, { type: "brace" }).state; // B scores nothing
    expect(s.robots.B.score).toBe(0);
    res = applyAction(board, rules, s, { type: "move", to: [2, 0] }); // left the uplink, still owns it
    expect(res.state.robots.A.score).toBe(2);
    expect(res.state.owners.west).toBe("A");
  });

  it("captures change hands", () => {
    const s = placed(board, [0, 0], [3, 0], (st) => {
      st.owners.prime = "A";
      st.active = "B";
    });
    const res = applyAction(board, rules, s, { type: "move", to: [4, 0] });
    expect(res.events).toContainEqual({ kind: "captured", side: "B", uplinkId: "prime", from: "A" });
    expect(res.state.robots.B.score).toBe(2);
  });

  it("disabling the enemy wins immediately", () => {
    const s = placed(board, [2, 0], [5, 0], (st) => (st.robots.B.hp = 2));
    const res = applyAction(board, rules, s, { type: "fire" });
    expect(res.state.result).toMatchObject({ winner: "A", reason: "disabled" });
    expect(res.events.map((e) => e.kind)).toEqual(["fired", "disabled", "game-over"]);
  });

  it("walking into overwatch at low HP loses", () => {
    const s = placed(board, [0, 0], [6, 0], (st) => {
      st.robots.A.hp = 1;
      st.robots.B.overwatch = true;
    });
    const res = applyAction(board, rules, s, { type: "move", to: [2, 0] });
    expect(res.state.result).toMatchObject({ winner: "B", reason: "disabled" });
  });

  it("reaching the score target wins", () => {
    const s = placed(board, [0, 0], [7, 0], (st) => (st.robots.A.score = rules.scoreToWin - 1));
    const res = applyAction(board, rules, s, { type: "move", to: [1, 0] });
    expect(res.state.result).toMatchObject({ winner: "A", reason: "score" });
  });

  it("at the turn limit: points, then HP, then draw", () => {
    const short = { ...rules, turnLimit: 2 };
    const run = (patch: (s: GameState) => void) => {
      let s = placed(board, [2, 0], [6, 0], patch);
      s = applyAction(board, short, s, { type: "brace" }).state;
      return applyAction(board, short, s, { type: "brace" }).state.result;
    };
    expect(run((s) => (s.robots.B.score = 3))).toMatchObject({ winner: "B", reason: "turn-limit" });
    expect(run((s) => (s.robots.A.hp = 4))).toMatchObject({ winner: "B", detail: expect.stringMatching(/more HP/) });
    expect(run(() => {})).toMatchObject({ winner: null, reason: "turn-limit", detail: expect.stringMatching(/draw/) });
  });
});
