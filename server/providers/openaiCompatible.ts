import { getJson, postJson } from "./http";
import { ProviderError, type ModelOption, type ProviderAdapter } from "./types";

interface ChatCompletion {
  choices?: { message?: { content?: string | null; refusal?: string | null } }[];
}

export interface OpenAICompatibleOptions {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  /** Local servers such as Ollama need no key. */
  keyRequired: boolean;
  models: ModelOption[];
  /** Ask the server which models it has (GET /models) and merge them into the list. */
  discoverModels?: boolean;
  extraHeaders?: Record<string, string>;
  /** Reasoning models reject custom temperature, so it is only sent where it is known to be accepted. */
  temperature?: number;
  setupHint: string;
}

/** One adapter for every endpoint that speaks the OpenAI chat-completions dialect. */
export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): ProviderAdapter {
  const base = options.baseUrl.replace(/\/+$/, "");
  const authHeaders = (): Record<string, string> => ({
    ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    ...options.extraHeaders,
  });

  return {
    id: options.id,
    label: options.label,
    async status() {
      const common = { freeformModels: true, setupHint: options.setupHint };
      if (options.keyRequired && !options.apiKey) {
        return { ...common, ready: false, detail: "No API key configured on the server", models: options.models, defaultModel: options.models[0]?.id ?? "" };
      }
      let models = options.models;
      if (options.discoverModels) {
        try {
          const body = (await getJson(`${base}/models`, authHeaders(), 1500)) as { data?: { id?: string }[] };
          const found = (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
          if (found.length) models = found.map((id) => ({ id, label: id }));
          else if (!options.keyRequired) return { ...common, ready: false, detail: "Server is running but has no models", models, defaultModel: "" };
        } catch {
          if (!options.keyRequired) return { ...common, ready: false, detail: `Not reachable at ${base}`, models, defaultModel: "" };
        }
      }
      return { ...common, ready: true, detail: options.keyRequired ? "API key configured" : `Connected to ${base}`, models, defaultModel: models[0]?.id ?? "" };
    },
    async generate({ system, prompt, model, signal }) {
      if (options.keyRequired && !options.apiKey) throw new ProviderError(`${options.label} has no API key. ${options.setupHint}`, false);
      const body = (await postJson(
        `${base}/chat/completions`,
        {
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        },
        authHeaders(),
        signal,
        options.label,
      )) as ChatCompletion;
      const message = body.choices?.[0]?.message;
      if (message?.refusal) throw new ProviderError(`${options.label} declined: ${message.refusal.slice(0, 160)}`, false);
      const content = message?.content;
      if (!content) throw new ProviderError(`${options.label} returned an empty message`, true);
      return content;
    },
  };
}
