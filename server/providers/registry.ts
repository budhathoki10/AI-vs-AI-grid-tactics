import type { ProviderInfo } from "../../src/ai/protocol";
import { createAnthropicProvider } from "./anthropic";
import { createClaudeCliProvider, createCodexCliProvider } from "./cli";
import { createGeminiProvider } from "./gemini";
import { createMockProvider } from "./mock";
import { createOpenAICompatibleProvider } from "./openaiCompatible";
import { createOpenRouterProvider } from "./openrouter";
import type { ProviderAdapter } from "./types";

type Env = Record<string, string | undefined>;

/**
 * Server keys come from environment variables (an OpenRouter key can also arrive from the player's browser).
 * Adding a provider means adding an adapter here; the game engine, decision pipeline and UI do not change.
 */
export function createRegistry(env: Env, options: { mockLatencyMs?: number } = {}): Map<string, ProviderAdapter> {
  const adapters: ProviderAdapter[] = [
    createMockProvider({ latencyMs: options.mockLatencyMs ?? Number(env.MOCK_LATENCY_MS ?? 900) }),
    // Signed-in CLIs: no API key, the user's Claude / ChatGPT subscription pays.
    createClaudeCliProvider(),
    createCodexCliProvider(),
    createAnthropicProvider(env.ANTHROPIC_API_KEY),
    createOpenAICompatibleProvider({
      id: "openai",
      label: "OpenAI",
      baseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY,
      keyRequired: true,
      models: [
        { id: "gpt-5", label: "gpt-5" },
        { id: "gpt-5-mini", label: "gpt-5-mini", hint: "Fast" },
        { id: "gpt-4.1", label: "gpt-4.1" },
      ],
      setupHint: "Set OPENAI_API_KEY in .env and restart the server.",
    }),
    createGeminiProvider(env.GEMINI_API_KEY),
    createOpenRouterProvider(env.OPENROUTER_API_KEY),
    createOpenAICompatibleProvider({
      id: "ollama",
      label: "Ollama (local)",
      baseUrl: `${(env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "")}/v1`,
      keyRequired: false,
      models: [],
      discoverModels: true,
      temperature: 0.4,
      setupHint: "Install Ollama, pull a model (e.g. `ollama pull llama3.1`), and keep it running.",
    }),
  ];

  if (env.CUSTOM_OPENAI_BASE_URL) {
    const models = (env.CUSTOM_OPENAI_MODELS ?? "")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean)
      .map((id) => ({ id, label: id }));
    adapters.push(
      createOpenAICompatibleProvider({
        id: "custom",
        label: env.CUSTOM_OPENAI_LABEL || "Custom endpoint",
        baseUrl: env.CUSTOM_OPENAI_BASE_URL,
        apiKey: env.CUSTOM_OPENAI_API_KEY,
        keyRequired: !!env.CUSTOM_OPENAI_API_KEY,
        models,
        discoverModels: models.length === 0,
        setupHint: "Configure CUSTOM_OPENAI_BASE_URL / CUSTOM_OPENAI_API_KEY / CUSTOM_OPENAI_MODELS in .env.",
      }),
    );
  }

  return new Map(adapters.map((a) => [a.id, a]));
}

export async function providerInfos(registry: Map<string, ProviderAdapter>, fresh = false): Promise<ProviderInfo[]> {
  return Promise.all(
    [...registry.values()].map(async (adapter) => {
      const base = { id: adapter.id, label: adapter.label };
      try {
        return { ...base, ...(await adapter.status(fresh)) };
      } catch (error) {
        return { ...base, ready: false, detail: (error as Error).message, models: [], freeformModels: true, defaultModel: "" };
      }
    }),
  );
}
