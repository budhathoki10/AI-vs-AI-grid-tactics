import { isDecisionsModel } from "../openRouterCatalog";
import { postJson } from "./http";
import { buildDecisionRequest, readDecisionAnswer } from "./openrouterDecisions";
import { ProviderError, type GenerateRequest, type ProviderAdapter } from "./types";

const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
/** OpenRouter's 400 for a decisions model sent to chat/completions; matched so an uncatalogued id still works. */
const DECISIONS_ONLY_ERROR = /is a decisions model/i;
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";

interface ChatCompletion {
  choices?: { message?: { content?: string | null; refusal?: string | null } }[];
}

const headers = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}`, "X-Title": "Uplink Duel" });

async function chat({ system, prompt, model, signal }: GenerateRequest, apiKey: string): Promise<string> {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];
  const body = (await postJson(CHAT_URL, { model, messages, temperature: 0.3 }, headers(apiKey), signal, "OpenRouter")) as ChatCompletion;
  const message = body.choices?.[0]?.message;
  if (message?.refusal) throw new ProviderError(`OpenRouter declined: ${message.refusal.slice(0, 160)}`, false);
  if (!message?.content) throw new ProviderError("OpenRouter returned an empty message", true);
  return message.content;
}

/** The answer comes back as the same JSON shape chat models use, so the engine's legality check applies unchanged. */
async function decisions({ model, signal, context }: GenerateRequest, apiKey: string): Promise<string> {
  const body = await postJson(DECISIONS_URL, buildDecisionRequest(model, context.rules, context.snapshot), headers(apiKey), signal, "OpenRouter");
  const reading = readDecisionAnswer(body, context.snapshot);
  if (!reading.ok) throw new ProviderError(`OpenRouter decisions: ${reading.reason}`, true);
  return JSON.stringify(reading.reply);
}

/** The key saved in the player's browser arrives with each request and wins over the server's environment key. */
export function createOpenRouterProvider(serverKey: string | undefined): ProviderAdapter {
  return {
    id: "openrouter",
    label: "OpenRouter",
    async status() {
      return {
        ready: !!serverKey,
        detail: serverKey ? "Using OPENROUTER_API_KEY from the server" : "Needs an API key",
        // The browser loads the full catalogue from /api/openrouter/models.
        models: [],
        freeformModels: true,
        defaultModel: DEFAULT_OPENROUTER_MODEL,
        setupHint: "Add your OpenRouter API key in Settings",
      };
    },
    async generate(request) {
      const apiKey = request.openRouterKey || serverKey;
      if (!apiKey) throw new ProviderError("Add your OpenRouter API key in Settings to use OpenRouter models", false);
      if (await isDecisionsModel(request.model)) return decisions(request, apiKey);
      try {
        return await chat(request, apiKey);
      } catch (error) {
        if (error instanceof ProviderError && DECISIONS_ONLY_ERROR.test(error.message)) return decisions(request, apiKey);
        throw error;
      }
    },
  };
}
