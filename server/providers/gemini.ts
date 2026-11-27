import { postJson } from "./http";
import { ProviderError, type ProviderAdapter } from "./types";

const MODELS = [
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "Fast" },
];

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

export function createGeminiProvider(apiKey: string | undefined): ProviderAdapter {
  const setupHint = "Set GEMINI_API_KEY in .env and restart the server.";
  return {
    id: "gemini",
    label: "Google Gemini",
    async status() {
      return {
        ready: !!apiKey,
        detail: apiKey ? "API key configured" : "No API key configured on the server",
        models: MODELS,
        freeformModels: true,
        defaultModel: MODELS[1].id,
        setupHint,
      };
    },
    async generate({ system, prompt, model, signal }) {
      if (!apiKey) throw new ProviderError(`Gemini has no API key. ${setupHint}`, false);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const body = (await postJson(
        url,
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" },
        },
        { "x-goog-api-key": apiKey },
        signal,
        "Gemini",
      )) as GenerateContentResponse;
      if (body.promptFeedback?.blockReason) throw new ProviderError(`Gemini blocked the prompt: ${body.promptFeedback.blockReason}`, false);
      const text = (body.candidates?.[0]?.content?.parts ?? [])
        .filter((p) => !p.thought)
        .map((p) => p.text ?? "")
        .join("");
      if (!text.trim()) throw new ProviderError(`Gemini returned no text (${body.candidates?.[0]?.finishReason ?? "no candidate"})`, true);
      return text;
    },
  };
}
