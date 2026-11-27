import type { PlayerConfig, ProviderInfo } from "../ai/protocol";
import { DEFAULT_MAP_ID, MAPS } from "../engine/maps";
import { DEFAULT_RULES } from "../engine/rules";
import type { Side } from "../engine/types";
import type { MatchConfig } from "../runner/MatchRunner";
import { colorDistance, MIN_COLOR_DISTANCE, TEAM_COLORS } from "./lib/palette";
import { MODEL_ID_PATTERN, OPENROUTER, shortName } from "./lib/providers";
import { loadJson, saveJson } from "./lib/storage";

export interface SetupState {
  players: Record<Side, PlayerConfig>;
  mapId: string;
  delayMs: number;
  turnLimit: number;
  firstSide: Side;
  seriesGames: number;
  retries: number;
  timeoutSec: number;
}

const KEY = "uplink-duel.setup.v1";

export const DEFAULT_SETUP: SetupState = {
  players: {
    A: { provider: "mock", model: "tactician", name: "Tactician", color: TEAM_COLORS[0].hex },
    B: { provider: "mock", model: "sentinel", name: "Sentinel", color: TEAM_COLORS[1].hex },
  },
  mapId: DEFAULT_MAP_ID,
  delayMs: 900,
  turnLimit: DEFAULT_RULES.turnLimit,
  firstSide: "A",
  seriesGames: 1,
  retries: 2,
  timeoutSec: 180,
};

export function loadSetup(): SetupState {
  const saved = loadJson<Partial<SetupState>>(KEY, {});
  const merged = { ...DEFAULT_SETUP, ...saved, players: { ...DEFAULT_SETUP.players, ...(saved.players ?? {}) } };
  if (!MAPS.some((m) => m.id === merged.mapId)) merged.mapId = DEFAULT_MAP_ID;
  return merged;
}

export function saveSetup(setup: SetupState): void {
  saveJson(KEY, setup);
}

export interface SetupIssue {
  side?: Side;
  field: "provider" | "model" | "color";
  message: string;
}

export function validateSetup(setup: SetupState, providers: ProviderInfo[] | null): SetupIssue[] {
  const issues: SetupIssue[] = [];
  for (const side of ["A", "B"] as const) {
    const p = setup.players[side];
    const provider = providers?.find((x) => x.id === p.provider);
    if (providers && !provider) issues.push({ side, field: "provider", message: "Choose an AI" });
    else if (provider && !provider.ready) {
      const message = provider.id === OPENROUTER ? "Add an OpenRouter API key in Settings" : `${shortName(provider)}: ${provider.detail}${provider.setupHint ? `. ${provider.setupHint}` : ""}`;
      issues.push({ side, field: "provider", message });
    }
    if (!p.model.trim()) issues.push({ side, field: "model", message: "Pick a model" });
    else if (provider?.models.find((m) => m.id === p.model)?.unavailable) issues.push({ side, field: "model", message: `Pick another model: ${provider.models.find((m) => m.id === p.model)!.unavailable!.toLowerCase()}` });
    else if (!MODEL_ID_PATTERN.test(p.model.trim())) issues.push({ side, field: "model", message: "A model id uses letters, numbers and . _ : / @ ~ - only" });
  }
  if (colorDistance(setup.players.A.color, setup.players.B.color) < MIN_COLOR_DISTANCE)
    issues.push({ side: "B", field: "color", message: "Pick a colour that is clearly different from Robot A's" });
  return issues;
}

export function toMatchConfig(setup: SetupState, id: string, seed: number): Omit<MatchConfig, "id" | "series"> & { id: string } {
  return {
    id,
    players: {
      A: { ...setup.players.A, model: setup.players.A.model.trim() },
      B: { ...setup.players.B, model: setup.players.B.model.trim() },
    },
    mapId: setup.mapId,
    swapStarts: false,
    firstSide: setup.firstSide,
    rules: { ...DEFAULT_RULES, turnLimit: setup.turnLimit },
    settings: { retries: setup.retries, timeoutMs: setup.timeoutSec * 1000 },
    delayMs: setup.delayMs,
    seed,
  };
}
