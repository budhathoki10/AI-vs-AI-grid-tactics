import type { Board, GameState, RulesConfig } from "../../src/engine/types";
import type { Snapshot } from "../../src/engine/snapshot";
import type { ModelOption, ProviderInfo } from "../../src/ai/protocol";

export interface GenerateRequest {
  system: string;
  prompt: string;
  model: string;
  /** Reasoning effort ("default" or a level from the provider's `efforts`). */
  effort?: string;
  signal: AbortSignal;
  /** OpenRouter key saved in the player's browser; only the OpenRouter provider reads it. */
  openRouterKey?: string;
  /** 0-based attempt number within one decision. */
  attempt: number;
  /** Structured context for providers that do not read prompts (the built-in mocks). */
  context: { board: Board; rules: RulesConfig; state: GameState; snapshot: Snapshot; seed: number };
}

/** A provider turns a prompt into reply text. It knows nothing about game rules. */
export interface ProviderAdapter {
  id: string;
  label: string;
  /** `fresh` skips any cached answer, for when the user has just signed in or started a local server. */
  status(fresh?: boolean): Promise<Omit<ProviderInfo, "id" | "label">>;
  generate(request: GenerateRequest): Promise<string>;
  /** Tries each model with a minimal request, so `status` can mark the ones this account cannot run. */
  checkModels?(signal: AbortSignal): Promise<void>;
}

/**
 * `retryable` separates transient trouble (timeouts, 429, 5xx, network) from setup problems
 * (missing key, unknown model) that no amount of retrying fixes.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly kind: "provider" | "timeout" = "provider",
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type { ModelOption };
