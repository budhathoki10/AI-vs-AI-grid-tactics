import type { DecisionResponse, ModelOption, ProviderInfo } from "../../ai/protocol";
import type { Decider } from "../../runner/MatchRunner";
import { loadOpenRouterKey } from "./storage";

export async function fetchProviders(signal?: AbortSignal, fresh = false): Promise<ProviderInfo[]> {
  const response = await fetch(fresh ? "/api/providers?fresh=1" : "/api/providers", { signal });
  if (!response.ok) throw new Error(`The game server answered ${response.status}`);
  const body = (await response.json()) as { providers: ProviderInfo[] };
  return body.providers;
}

/** Tries each model on the user's account. Resolves with the refreshed providers and any model that could not be checked. */
export async function checkProviderModels(providerId: string): Promise<{ providers: ProviderInfo[]; error: string | null }> {
  const response = await fetch(`/api/providers/${encodeURIComponent(providerId)}/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const body = (await response.json().catch(() => null)) as { providers?: ProviderInfo[]; error?: string } | null;
  if (!body?.providers) throw new Error(body?.error ?? `The game server answered ${response.status}`);
  return { providers: body.providers, error: body.error ?? null };
}

export async function fetchOpenRouterModels(signal?: AbortSignal): Promise<ModelOption[]> {
  const response = await fetch("/api/openrouter/models", { signal });
  const body = (await response.json().catch(() => null)) as { models?: ModelOption[]; error?: string } | null;
  if (!response.ok || !body?.models) throw new Error(body?.error ?? `Could not load OpenRouter models (${response.status})`);
  return body.models;
}

/** Sends decisions to the local server. An OpenRouter key saved in this browser travels with OpenRouter turns only. */
export const httpDecider: Decider = {
  async decide(request, signal) {
    // Read at send time, so a key changed during a match applies to the next turn or a retry.
    const key = request.player.provider === "openrouter" ? loadOpenRouterKey() : "";
    let response: Response;
    try {
      response = await fetch("/api/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(key ? { ...request, openRouterKey: key } : request),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error("Could not reach the game server. Is `npm run dev` still running?");
    }
    const body = (await response.json().catch(() => null)) as (DecisionResponse & { error?: string }) | null;
    if (!body) throw new Error(`The game server answered ${response.status} without a body`);
    if (response.status === 200 || response.status === 502) return body;
    throw new Error(body.error ?? `The game server answered ${response.status}`);
  },
};
