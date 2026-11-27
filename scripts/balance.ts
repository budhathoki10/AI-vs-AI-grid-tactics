/** Dev tool: plays mock-vs-mock matches in-process and prints outcome statistics. `npx tsx scripts/balance.ts` */
import { MOCK_MODELS, mockDecide } from "../src/ai/mock";
import { applyAction, createInitialState } from "../src/engine/engine";
import { buildBoard, MAPS } from "../src/engine/maps";
import { DEFAULT_RULES } from "../src/engine/rules";
import { buildSnapshot, type HistoryLine } from "../src/engine/snapshot";
import type { Side } from "../src/engine/types";

const rules = { ...DEFAULT_RULES, ...(process.argv[2] ? JSON.parse(process.argv[2]) : {}) };
const quiet = process.argv.includes("--quiet");
let firstWins = 0, decided = 0, allGames = 0, allTurns = 0;
const reasons: Record<string, number> = {};
const personas = Object.fromEntries(MOCK_MODELS.map((m) => [m.id, m.persona]));
const pairs: [string, string][] = [
  ["tactician", "tactician"],
  ["tactician", "sentinel"],
  ["tactician", "aggressor"],
  ["sentinel", "opportunist"],
  ["aggressor", "opportunist"],
  ["tactician", "wildcard"],
];

for (const map of MAPS) {
  for (const [a, b] of pairs) {
    const tally: Record<string, number> = {};
    let turns = 0;
    const games = 10;
    const started = Date.now();
    for (let g = 0; g < games; g++) {
      const first: Side = g % 2 === 0 ? "A" : "B";
      const board = buildBoard(map, g % 4 >= 2);
      let state = createInitialState(board, rules, first);
      const history: HistoryLine[] = [];
      while (!state.result) {
        const persona = personas[state.active === "A" ? a : b];
        const snap = buildSnapshot(board, rules, state, history);
        const { action } = mockDecide(board, rules, state, snap, persona, 1000 + g);
        const res = applyAction(board, rules, state, action);
        history.push({ turn: state.turn, side: state.active, action, events: res.events });
        state = res.state;
      }
      const key = `${state.result.winner ? (state.result.winner === "A" ? a + "(A)" : b + "(B)") : "draw"}/${state.result.reason}${state.result.winner === first ? "/first" : ""}`;
      tally[key] = (tally[key] ?? 0) + 1;
      turns += state.turn;
      allGames++; allTurns += state.turn; reasons[state.result.reason] = (reasons[state.result.reason] ?? 0) + 1;
      if (state.result.winner) { decided++; if (state.result.winner === first) firstWins++; }
    }
    if (!quiet) console.log(`${map.id} ${a} vs ${b}: avg turns ${(turns / games).toFixed(1)}, ${((Date.now() - started) / games).toFixed(0)}ms/game`, tally);
  }
}

console.log(`rules ${JSON.stringify(process.argv[2] ?? {})}: games ${allGames}, avg turns ${(allTurns / allGames).toFixed(1)}, first-mover wins ${firstWins}/${decided}`, reasons);
