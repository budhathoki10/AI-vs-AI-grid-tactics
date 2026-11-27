import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, type ProviderAdapter } from "./types";

const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Default" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "Fastest" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2", hint: "Most capable" },
];

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-fable-5-1", "claude-opus-5"]);

export function createAnthropicProvider(apiKey: string | undefined): ProviderAdapter {
  // Retries are owned by the decision pipeline so every retry shows up in the match log.
  const client = apiKey ? new Anthropic({ apiKey, maxRetries: 0 }) : null;
  const setupHint = "Set ANTHROPIC_API_KEY in .env and restart the server.";

  return {
    id: "anthropic",
    label: "Anthropic",
    async status() {
      return {
        ready: !!client,
        detail: client ? "API key configured" : "No API key configured on the server",
        models: MODELS,
        freeformModels: true,
        defaultModel: MODELS[0].id,
        setupHint,
      };
    },
    async generate({ system, prompt, model, signal }) {
      if (!client) throw new ProviderError(`Anthropic has no API key. ${setupHint}`, false);
      try {
        const response = await client.beta.messages.create(
          {
            model,
            max_tokens: 16000,
            system,
            messages: [{ role: "user", content: prompt }],
            // A tactical turn is a small, bounded decision; medium effort keeps turns watchable.
            output_config: { effort: "medium" },
            ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          { signal },
        );
        if (response.stop_reason === "refusal") throw new ProviderError("Anthropic declined to answer this turn", false);
        const text = response.content
          .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        if (!text.trim()) throw new ProviderError("Anthropic returned no text", true);
        return text;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (signal.aborted) throw signal.reason;
        if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError)
          throw new ProviderError(`Anthropic rejected the API key: ${error.message}`, false);
        if (error instanceof Anthropic.NotFoundError) throw new ProviderError(`Anthropic does not know model "${model}"`, false);
        if (error instanceof Anthropic.RateLimitError) throw new ProviderError(`Anthropic rate limit: ${error.message}`, true);
        if (error instanceof Anthropic.BadRequestError) throw new ProviderError(`Anthropic rejected the request: ${error.message}`, false);
        if (error instanceof Anthropic.APIConnectionError) throw new ProviderError(`Could not reach Anthropic: ${error.message}`, true);
        if (error instanceof Anthropic.APIError) throw new ProviderError(`Anthropic error ${error.status ?? ""}: ${error.message}`, (error.status ?? 500) >= 500);
        throw error;
      }
    },
  };
}
