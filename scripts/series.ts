/**
 * Headless series: plays N games between two models through the same server pipeline (prompt → provider →
 * parse → validate), alternating first move and start tiles, and saves every match record.
 *
 *   npm run series -- --a=mock/tactician --b=mock/sentinel --games=6 --map=foundry
 *   npm run series -- --a=anthropic/claude-opus-5-5 --b=openai/gpt-5-mini --games=4
 *
 * Provider keys come from .env.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../server/decide";
import { createRegistry } from "../server/providers/registry";
import { buildBoard, getMap, MAPS } from "../src/engine/maps";
import { sideStats, type MatchRecord } from "../src/engine/record";
import { DEFAULT_RULES } from "../src/engine/rules";
import { MatchRunner, planSeries, type Decider } from "../src/runner/MatchRunner";
import { TEAM_COLORS } from "../src/client/lib/palette";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  /* optional */
}

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const [providerA, ...modelA] = arg("a", "mock/tactician").split("/");
const [providerB, ...modelB] = arg("b", "mock/sentinel").split("/");
const games = Math.max(1, Math.min(50, Number(arg("games", "4"))));
const mapId = arg("map", "foundry");
const turnLimit = Number(arg("turns", String(DEFAULT_RULES.turnLimit)));
const out = path.resolve(root, arg("out", "matches"));
if (!MAPS.some((m) => m.id === mapId)) {
  console.error(`Unknown map "${mapId}". Choose one of: ${MAPS.map((m) => m.id).join(", ")}`);
  process.exit(1);
}

const registry = createRegistry(process.env, { mockLatencyMs: 0 });
const decider: Decider = {
  decide(request, signal) {
    return decide(request, buildBoard(getMap(request.mapId), request.swapStarts), registry, signal);
  },
};

const nameA = arg("name-a", modelA.join("/"));
const nameB = arg("name-b", modelB.join("/"));
const base = {
  players: {
    A: { provider: providerA, model: modelA.join("/"), name: nameA, color: TEAM_COLORS[0].hex },
    B: { provider: providerB, model: modelB.join("/"), name: nameB === nameA ? `${nameB} (B)` : nameB, color: TEAM_COLORS[1].hex },
  },
  mapId,
  swapStarts: false,
  firstSide: "A" as const,
  rules: { ...DEFAULT_RULES, turnLimit },
  settings: { retries: 2, timeoutMs: 120_000 },
  delayMs: 0,
  seed: Number(arg("seed", String(Date.now() % 2 ** 31))),
};

const seriesId = `series-${Date.now().toString(36)}`;
let n = 0;
const configs = planSeries(base, games, seriesId, () => `${seriesId}-g${++n}`);
mkdirSync(out, { recursive: true });

console.log(`Uplink Duel series: ${nameA} (A) vs ${base.players.B.name} (B), ${games} game(s) on ${getMap(mapId).name}\n`);
const records: MatchRecord[] = [];
for (const config of configs) {
  const runner = new MatchRunner(config, decider, null, { sleep: async () => {} });
  const record = await new Promise<MatchRecord>((resolve) => {
    runner.subscribe(() => {
      const snap = runner.getSnapshot();
      if (snap.phase === "error" && snap.error) {
        console.error(`  game ${config.series!.game}: ${snap.error.message} — stopping this game`);
        runner.stop();
      }
      if (snap.phase === "over" || snap.phase === "stopped") resolve(snap.record);
    });
    runner.start();
  });
  records.push(record);
  writeFileSync(path.join(out, `${record.id}.json`), JSON.stringify(record, null, 2));
  const r = record.result!;
  const winner = r.winner ? record.players[r.winner].name : "draw";
  const a = sideStats(record, "A");
  const b = sideStats(record, "B");
  console.log(
    `  game ${config.series!.game}: first=${config.firstSide} swapStarts=${config.swapStarts} → ${winner.padEnd(14)} ${r.reason.padEnd(10)} ${String(record.turns.length).padStart(2)} actions | retries A=${a.retries} B=${b.retries} fallbacks A=${a.fallbacks} B=${b.fallbacks}`,
  );
}

const tally = { A: 0, B: 0, draw: 0, stopped: 0 };
for (const r of records) {
  if (!r.result || r.result.reason === "stopped") tally.stopped++;
  else if (r.result.winner) tally[r.result.winner]++;
  else tally.draw++;
}
console.log(`\n${nameA} ${tally.A} – ${tally.B} ${base.players.B.name}, ${tally.draw} draw(s)${tally.stopped ? `, ${tally.stopped} unfinished` : ""}`);
console.log(`Records saved to ${path.relative(root, out)}/. These results describe play in Uplink Duel only.`);
