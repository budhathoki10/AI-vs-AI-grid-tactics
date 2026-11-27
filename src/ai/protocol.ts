import type { HistoryLine } from "../engine/snapshot";
import type { Action, GameState, RulesConfig, Side } from "../engine/types";

/** What the user picked for one robot in setup. */
export interface PlayerConfig {
  provider: string;
  model: string;
  /** Display name shown to viewers. */
  name: string;
  /** Team colour, #rrggbb. */
  color: string;
  /** Reasoning effort for providers that support it (the signed-in CLIs). */
  effort?: string;
}

export interface DecisionSettings {
  /** Extra attempts after a malformed/illegal reply or a retryable provider error. */
  retries: number;
  timeoutMs: number;
}

export interface DecisionRequest {
  matchId: string;
  /** Monotonic per match run; a restart bumps it so late answers for an old run are dropped. */
  epoch: number;
  turn: number;
  side: Side;
  mapId: string;
  swapStarts: boolean;
  rules: RulesConfig;
  state: GameState;
  history: HistoryLine[];
  player: Pick<PlayerConfig, "provider" | "model" | "effort">;
  settings: DecisionSettings;
  /** Deterministic seed for mock models. */
  seed: number;
  /** The player's OpenRouter key, added when the request is sent. Never part of match state or records. */
  openRouterKey?: string;
}

export type AttemptKind = "parse" | "illegal" | "provider" | "timeout";

export interface Attempt {
  kind: AttemptKind;
  error: string;
  /** First characters of the raw reply, for the match log. */
  excerpt: string;
  durationMs: number;
}

export type DecisionResponse =
  | {
      ok: true;
      turn: number;
      epoch: number;
      action: Action;
      /** The model's own short explanation, empty when it gave none. Never invented. */
      explanation: string;
      /** True when every attempt failed and the engine substituted a safe action. */
      fallback: boolean;
      /** Rejected or failed attempts before the accepted one. */
      attempts: Attempt[];
      durationMs: number;
    }
  | {
      ok: false;
      turn: number;
      epoch: number;
      error: string;
      /** Whether retrying the same request later could succeed (rate limit, network) vs. a setup problem. */
      retryable: boolean;
      attempts: Attempt[];
      durationMs: number;
    };

export interface ModelOption {
  id: string;
  label: string;
  hint?: string;
  /** Why the signed-in account cannot run this model; such a model cannot be selected. */
  unavailable?: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  ready: boolean;
  detail: string;
  models: ModelOption[];
  /** Users may type a model id that is not in the list. */
  freeformModels: boolean;
  defaultModel: string;
  setupHint?: string;
  /** Effort levels this provider accepts; absent when it has none. */
  efforts?: string[];
  /** Subscription plan of the signed-in CLI account, e.g. "pro" or "free". */
  plan?: string;
  /** The user can ask the provider to try each model on their account. */
  canCheckModels?: boolean;
}
