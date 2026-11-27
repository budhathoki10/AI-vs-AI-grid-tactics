import { glitchReply, MOCK_MODELS, mockDecide, mockReply } from "../../src/ai/mock";
import { ProviderError, type ProviderAdapter } from "./types";

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Mock models think for a short, varied time so viewers see the same "thinking" rhythm as with a real model.
 * `latencyMs: 0` makes them instant for tests and headless series.
 */
export function createMockProvider({ latencyMs = 900 }: { latencyMs?: number } = {}): ProviderAdapter {
  return {
    id: "mock",
    label: "Built-in mock",
    async status() {
      return {
        ready: true,
        detail: "No API key needed",
        models: MOCK_MODELS.map(({ id, label, hint }) => ({ id, label, hint })),
        freeformModels: false,
        defaultModel: "tactician",
      };
    },
    async generate({ model, signal, attempt, context }) {
      const entry = MOCK_MODELS.find((m) => m.id === model);
      if (!entry) throw new ProviderError(`Unknown mock model "${model}"`, false);
      if (latencyMs > 0) {
        const jitter = ((context.state.turn * 7919 + context.seed) % 1000) / 1000;
        await wait(Math.round(latencyMs * (0.5 + jitter)), signal);
      }
      if (entry.persona.glitchy) {
        const broken = glitchReply(context.state, attempt);
        if (broken !== null) return broken;
      }
      const decision = mockDecide(context.board, context.rules, context.state, context.snapshot, entry.persona, context.seed);
      return mockReply(decision);
    },
  };
}
