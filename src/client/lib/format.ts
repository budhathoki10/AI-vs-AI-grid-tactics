import type { PlayerConfig, ProviderInfo } from "../../ai/protocol";
import type { Action, GameEvent, Side } from "../../engine/types";

/** Engine messages say "Robot A"; viewers should see the display names. */
export function named(text: string, players: Record<Side, { name: string }>): string {
  return text.replace(/Robot ([AB])/g, (_, s: Side) => players[s].name);
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function actionLabel(action: Action): string {
  switch (action.type) {
    case "move":
      return `Move to ${action.to[0]},${action.to[1]}`;
    case "fire":
      return "Fire";
    case "brace":
      return "Brace";
    case "overwatch":
      return "Overwatch";
  }
}

/** Plain-language consequences, so viewers never need the raw model output. */
export function eventLines(events: GameEvent[], name: (s: Side) => string, uplinkName: (id: string) => string): string[] {
  const out: string[] = [];
  for (const e of events) {
    switch (e.kind) {
      case "moved":
        out.push(`Moved ${e.path.length - 1} step${e.path.length === 2 ? "" : "s"} to ${e.path[e.path.length - 1].join(",")}`);
        break;
      case "fired":
        out.push(
          `${e.reaction ? "Overwatch triggered: " : ""}${name(e.side)} hit ${name(e.target)} for ${e.damage}${e.modifiers.filter((m) => m !== "minimum").length ? ` (${e.modifiers.filter((m) => m !== "minimum").join(", ")})` : ""}`,
        );
        break;
      case "braced":
        out.push("Braced");
        break;
      case "overwatch-set":
        out.push(`Overwatch armed over ${e.watched.length} tiles`);
        break;
      case "overwatch-expired":
        break;
      case "captured":
        out.push(`Captured the ${uplinkName(e.uplinkId)}${e.from ? ` from ${name(e.from)}` : ""}`);
        break;
      case "scored":
        out.push(`+${e.points} point${e.points === 1 ? "" : "s"} (total ${e.total})`);
        break;
      case "disabled":
        out.push(`${name(e.side)} was disabled`);
        break;
      case "game-over":
        break;
    }
  }
  return out;
}

export function modelLabel(player: PlayerConfig, providers: ProviderInfo[]): string {
  const provider = providers.find((p) => p.id === player.provider);
  const model = provider?.models.find((m) => m.id === player.model);
  return `${provider?.label ?? player.provider} · ${model?.label ?? player.model}`;
}
