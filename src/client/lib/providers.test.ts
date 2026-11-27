import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionRequest, PlayerConfig, ProviderInfo } from "../../ai/protocol";
import { httpDecider } from "./api";
import { planSummary, providerChoices, settlePlayer, switchProvider, withModelNames, withOpenRouter } from "./providers";

const info = (id: string, ready: boolean, models: [string, string][], extra: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id,
  label: id,
  ready,
  detail: "",
  models: models.map(([modelId, label]) => ({ id: modelId, label })),
  freeformModels: false,
  defaultModel: models[0]?.[0] ?? "",
  ...extra,
});

const providers: ProviderInfo[] = [
  info("mock", true, [["sentinel", "Sentinel"]]),
  info(
    "claude-cli",
    true,
    [
      ["claude-haiku-5-5", "Claude Haiku 5.5"],
      ["claude-opus-5-5", "Claude Opus 5.5"],
    ],
    { efforts: ["default", "low"] },
  ),
  info("codex-cli", false, [["gpt-codex", "GPT-Codex"]]),
  info("anthropic", false, [["claude-opus-5-5", "Claude Opus 5.5"]]),
  info("openrouter", false, [], { defaultModel: "openai/gpt-4o-mini", freeformModels: true }),
  info("ollama", true, [["llama3.2", "llama3.2"]]),
];

const player = (provider: string, model: string, name = ""): PlayerConfig => ({ provider, model, name, color: "#4c7dff" });

describe("AI picker", () => {
  it("always offers Claude, Codex, OpenRouter and practice bots, and other providers only when usable", () => {
    expect(providerChoices(providers, "mock").map((p) => p.id)).toEqual(["claude-cli", "codex-cli", "openrouter", "mock", "ollama"]);
    expect(providerChoices(providers, "anthropic").map((p) => p.id)).toContain("anthropic");
  });

  it("makes OpenRouter ready once a key is saved in the browser, and fills in its catalogue", () => {
    const catalog = [{ id: "openai/gpt-4o-mini", label: "OpenAI: GPT-4o-mini" }];
    expect(withOpenRouter(providers, false, catalog).find((p) => p.id === "openrouter")).toMatchObject({ ready: false, models: catalog });
    expect(withOpenRouter(providers, true, catalog).find((p) => p.id === "openrouter")).toMatchObject({ ready: true });
  });

  it("switches to the new provider's default model and effort", () => {
    expect(switchProvider(player("mock", "sentinel"), providers[1])).toMatchObject({ provider: "claude-cli", model: "claude-haiku-5-5", effort: "low" });
    expect(switchProvider({ ...player("claude-cli", "claude-opus-5-5"), effort: "low" }, providers[4])).toMatchObject({ model: "openai/gpt-4o-mini", effort: undefined });
  });

  it("forgets the previous model's name when the AI changes", () => {
    const moved = switchProvider(player("codex-cli", "gpt-codex", "GPT-Codex"), providers[4]);
    expect(withModelNames({ A: moved, B: player("mock", "sentinel") }, providers).A.name).toBe("openai/gpt-4o-mini");
  });

  it("moves off a model the account cannot run, and says how many it can", () => {
    const limited = info("claude-cli", true, [["claude-haiku-5-5", "Claude Haiku 5.5"], ["claude-fable-5-2", "Claude Fable 5.2"]], { plan: "pro", canCheckModels: true });
    limited.models[1].unavailable = "Needs usage credits";
    expect(settlePlayer(player("claude-cli", "claude-fable-5-2"), [limited]).model).toBe("claude-haiku-5-5");
    expect(planSummary(limited)).toBe("Claude Pro plan · 1 of 2 models available");
  });

  it("replaces a saved model that has disappeared, but never a typed OpenRouter id", () => {
    expect(settlePlayer(player("claude-cli", "claude-retired"), providers).model).toBe("claude-haiku-5-5");
    const typed = player("openrouter", "brand-new/model");
    expect(settlePlayer(typed, providers)).toBe(typed);
  });
});

describe("robot names", () => {
  const names = (a: PlayerConfig, b: PlayerConfig, list: ProviderInfo[] | null) => {
    const named = withModelNames({ A: a, B: b }, list);
    return [named.A.name, named.B.name];
  };

  it("are the model's own name, replacing anything saved before", () => {
    expect(names(player("claude-cli", "claude-opus-5-5", "My own name"), player("mock", "sentinel", "x"), providers)).toEqual(["Claude Opus 5.5", "Sentinel"]);
  });

  it("mark the side when both robots use the same model", () => {
    expect(names(player("claude-cli", "claude-opus-5-5"), player("anthropic", "claude-opus-5-5"), providers)).toEqual(["Claude Opus 5.5 (A)", "Claude Opus 5.5 (B)"]);
  });

  it("keep the last known name until the model list arrives", () => {
    const saved = player("openrouter", "openai/gpt-4o-mini", "OpenAI: GPT-4o-mini");
    expect(names(saved, player("mock", "sentinel"), null)).toEqual(["OpenAI: GPT-4o-mini", "sentinel"]);
    expect(names(saved, player("mock", "sentinel"), providers)[0]).toBe("OpenAI: GPT-4o-mini");
  });
});

describe("sending a turn", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function sentBody(provider: string, savedKey: string | null): Promise<Record<string, unknown>> {
    let body = "";
    vi.stubGlobal("localStorage", { getItem: () => (savedKey === null ? null : JSON.stringify(savedKey)) });
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await httpDecider.decide({ player: { provider, model: "m" } } as DecisionRequest, new AbortController().signal);
    return JSON.parse(body);
  }

  it("adds the saved OpenRouter key to OpenRouter turns only", async () => {
    expect(await sentBody("openrouter", "sk-or-browser")).toMatchObject({ openRouterKey: "sk-or-browser" });
    expect(await sentBody("claude-cli", "sk-or-browser")).not.toHaveProperty("openRouterKey");
    expect(await sentBody("openrouter", null)).not.toHaveProperty("openRouterKey");
  });
});
