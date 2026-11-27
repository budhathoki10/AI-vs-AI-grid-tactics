import type { ModelOption, PlayerConfig, ProviderInfo } from "../../ai/protocol";
import type { Side } from "../../engine/types";

export const OPENROUTER = "openrouter";

/** Model ids reach a CLI argv and an HTTP body, so only plain identifier characters are accepted. */
export const MODEL_ID_PATTERN = /^[\w.:/@~-]{1,120}$/;

/** Always offered. The other providers appear once the server can use them. */
const MAIN_PROVIDERS = ["claude-cli", "codex-cli", OPENROUTER, "mock"];
const SHORT_NAMES: Record<string, string> = {
  "claude-cli": "Claude",
  "codex-cli": "Codex",
  [OPENROUTER]: "OpenRouter",
  mock: "Practice",
  anthropic: "Anthropic API",
  openai: "OpenAI API",
  gemini: "Gemini",
  ollama: "Ollama",
};

export const shortName = (provider: ProviderInfo): string => SHORT_NAMES[provider.id] ?? provider.label;

export function providerChoices(providers: ProviderInfo[], selected: string): ProviderInfo[] {
  const main = MAIN_PROVIDERS.map((id) => providers.find((p) => p.id === id)).filter((p): p is ProviderInfo => !!p);
  return [...main, ...providers.filter((p) => !MAIN_PROVIDERS.includes(p.id) && (p.ready || p.id === selected))];
}

/** Adds what only this browser knows about OpenRouter: whether a key is saved here, and the model catalogue. */
export function withOpenRouter(providers: ProviderInfo[], hasKey: boolean, catalog: ModelOption[]): ProviderInfo[] {
  return providers.map((p) => (p.id === OPENROUTER ? { ...p, ready: p.ready || hasKey, detail: hasKey ? "Using the API key saved in this browser" : p.detail, models: catalog } : p));
}

/** "ChatGPT Free plan · 3 of 4 models available", for a signed-in CLI. */
export function planSummary(provider: ProviderInfo): string | null {
  if (!provider.ready || (!provider.plan && !provider.canCheckModels)) return null;
  const vendor = provider.id === "codex-cli" ? "ChatGPT" : "Claude";
  const plan = provider.plan ? `${vendor} ${provider.plan[0].toUpperCase()}${provider.plan.slice(1)} plan` : `${vendor} account`;
  const usable = provider.models.filter((m) => !m.unavailable).length;
  const count = usable === provider.models.length ? `${usable} models` : `${usable} of ${provider.models.length} models available`;
  return `${plan} · ${count}`;
}

export function switchProvider(player: PlayerConfig, target: ProviderInfo): PlayerConfig {
  const model = target.models.some((m) => m.id === player.model && !m.unavailable) ? player.model : target.defaultModel;
  return { ...player, provider: target.id, model, name: "", effort: target.efforts ? (player.effort ?? "low") : undefined };
}

/**
 * A saved model can disappear from a provider's list (plan change, CLI update, model removed from Ollama);
 * fall back to that provider's default. OpenRouter ids are typed freely, so they are left alone.
 */
export function settlePlayer(player: PlayerConfig, providers: ProviderInfo[]): PlayerConfig {
  const provider = providers.find((p) => p.id === player.provider);
  if (!provider || provider.id === OPENROUTER || !provider.models.length || !provider.defaultModel) return player;
  return provider.models.some((m) => m.id === player.model && !m.unavailable) ? player : { ...player, model: provider.defaultModel, name: "" };
}

/** Robots are always called by their model's name. Two robots on the same name are told apart by their side. */
export function withModelNames(players: Record<Side, PlayerConfig>, providers: ProviderInfo[] | null): Record<Side, PlayerConfig> {
  const name = (p: PlayerConfig) => {
    const listed = providers?.find((x) => x.id === p.provider)?.models.find((m) => m.id === p.model)?.label;
    // Until the model list arrives, the name saved last time is the best guess at the model's label.
    const unlisted = !providers || (p.provider === OPENROUTER && !providers.find((x) => x.id === OPENROUTER)?.models.length);
    return (listed ?? ((unlisted && p.name) || p.model)).trim() || "No model";
  };
  const [a, b] = [name(players.A), name(players.B)];
  const same = a === b;
  return { A: { ...players.A, name: same ? `${a} (A)` : a }, B: { ...players.B, name: same ? `${b} (B)` : b } };
}
