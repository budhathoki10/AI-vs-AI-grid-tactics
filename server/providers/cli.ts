import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { ModelOption } from "../../src/ai/protocol";
import { CliError, lastLines, runCli } from "../runCli";
import { readCodexAccount } from "./codexAccount";
import { ProviderError, type ProviderAdapter } from "./types";

/**
 * Providers that use a CLI you are already signed in to, so your Claude or ChatGPT subscription pays and no
 * API key is needed. Each call is a single, tool-less text completion in a throwaway context.
 */

const STATUS_TIMEOUT_MS = 15_000;
/** Hard ceiling; the match's decision timeout (an abort signal) normally ends a call sooner. */
const CALL_CEILING_MS = 300_000;
const STATUS_TTL_MS = 30_000;

export const CLI_EFFORTS = ["default", "low", "medium", "high"];

const bin = {
  claude: () => process.env.CLAUDE_BIN ?? "claude",
  codex: () => process.env.CODEX_BIN ?? "codex",
};

/** `/api/providers` runs on every page load; the CLI status checks are cached briefly so the setup screen stays fast. */
function cached<T>(fn: () => Promise<T>): (fresh?: boolean) => Promise<T> {
  let value: { at: number; result: Promise<T> } | null = null;
  return (fresh = false) => {
    if (fresh || !value || Date.now() - value.at > STATUS_TTL_MS) value = { at: Date.now(), result: fn() };
    return value.result;
  };
}

function rethrow(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw signal.reason;
  if (error instanceof CliError) throw new ProviderError(error.message, error.kind === "timeout", error.kind === "timeout" ? "timeout" : "provider");
  throw error;
}

// ------------------------------------------------------------------------------------------- Claude Code

const CLAUDE_MODELS: ModelOption[] = [
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "Fastest" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Balanced" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Strongest" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2", hint: "Needs usage credits" },
];

/** Claude Code's wording when an account's plan or credits do not cover a model. Rate limits must not match. */
export const UNSUPPORTED_CLAUDE = /requires? usage credits|not (available|included) (on|in|with|for) your|do(es)? not have access|model_not_found|issue with the selected model/i;

export function createClaudeCliProvider(): ProviderAdapter {
  /** Models this account was refused, with Claude Code's reason. Cleared when the plan changes. */
  const refused = new Map<string, string>();
  let knownPlan: string | undefined;
  let checking: Promise<void> | null = null;

  const readStatus = cached(async () => {
    const base = { models: CLAUDE_MODELS, freeformModels: false, defaultModel: CLAUDE_MODELS[0].id, efforts: CLI_EFFORTS };
    try {
      const { stdout } = await runCli({ command: bin.claude(), args: ["auth", "status"], timeoutMs: STATUS_TIMEOUT_MS });
      const s = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
      if (!s.loggedIn) return { ...base, ready: false, detail: "Not signed in", setupHint: "Run `claude auth login` in a terminal, then press Check sign-in" };
      const plan = s.subscriptionType;
      if (plan !== knownPlan) refused.clear();
      knownPlan = plan;
      return { ...base, ready: true, detail: `Signed in (${s.authMethod ?? "account"})`, canCheckModels: true, ...(plan ? { plan } : {}) };
    } catch (error) {
      return { ...base, ready: false, detail: (error as Error).message, setupHint: "Install Claude Code (npm i -g @anthropic-ai/claude-code), run `claude auth login`, then press Check sign-in" };
    }
  });

  async function ask(system: string, prompt: string, model: string, effort: string | undefined, signal: AbortSignal): Promise<string> {
    // No tools, no user settings, hooks or MCP servers, no saved session: a pure text completion.
    const args = ["-p", prompt, "--model", model, "--system-prompt", system, "--tools", "", "--output-format", "json", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config"];
    if (effort && effort !== "default") args.push("--effort", effort);
    try {
      const { stdout, stderr, exitCode } = await runCli({ command: bin.claude(), args, timeoutMs: CALL_CEILING_MS, signal });
      let parsed: { is_error?: boolean; result?: string } | null = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }
      if (parsed?.is_error || exitCode !== 0) {
        const detail = parsed?.result || lastLines(stderr) || lastLines(stdout) || `exit code ${exitCode}`;
        if (UNSUPPORTED_CLAUDE.test(detail)) {
          refused.set(model, /usage credits/i.test(detail) ? "Needs usage credits" : "Not available on your plan");
          throw new ProviderError(`Claude Code error: ${detail}`, false);
        }
        throw new ProviderError(`Claude Code error: ${detail}`, /overloaded|rate.?limit|timeout|529|5\d\d/i.test(detail));
      }
      refused.delete(model);
      const text = parsed?.result ?? stdout;
      if (!text.trim()) throw new ProviderError("Claude Code returned an empty answer", true);
      return text;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      rethrow(error, signal);
    }
  }

  return {
    id: "claude-cli",
    label: "Claude Code",
    async status(fresh) {
      const status = await readStatus(fresh);
      const models = status.models.map((m) => (refused.has(m.id) ? { ...m, hint: undefined, unavailable: refused.get(m.id) } : m));
      return { ...status, models, defaultModel: models.find((m) => !m.unavailable)?.id ?? status.defaultModel };
    },
    generate: ({ system, prompt, model, effort, signal }) => ask(system, prompt, model, effort, signal),
    checkModels(signal) {
      // One check at a time: each one spends a little of the user's quota.
      checking ??= Promise.allSettled(CLAUDE_MODELS.map((m) => ask("Reply with the single word ok.", "ok", m.id, "low", signal)))
        .then((results) => {
          // A refusal is an answer. Anything else (rate limit, network) means that model was not checked.
          const failed = results.flatMap((r, i) => (r.status === "rejected" && !refused.has(CLAUDE_MODELS[i].id) ? [`${CLAUDE_MODELS[i].label}: ${(r.reason as Error).message}`] : []));
          if (failed.length) throw new ProviderError(`Could not check ${failed.join("; ")}`, true);
        })
        .finally(() => (checking = null));
      return checking;
    },
  };
}

// ------------------------------------------------------------------------------------------- Codex (ChatGPT sign-in)

interface CodexCacheEntry {
  slug?: string;
  display_name?: string;
  visibility?: string;
}

const codexHome = () => process.env.CODEX_HOME || path.join(homedir(), ".codex");
export const UNSUPPORTED_CODEX = /not supported when using codex|model_not_found|does not exist or you do not have access/i;
export const EXPIRED_CODEX = /refresh token was revoked|log out and sign in again|refresh token.*expired/i;
/** Models the CLI refused for this sign-in. Its cached model list can include models the plan cannot run. */
const codexRefused = new Set<string>();

/** The `model` set in the user's config.toml, if any. */
async function codexConfiguredModel(): Promise<string | null> {
  const text = await readFile(path.join(codexHome(), "config.toml"), "utf8").catch(() => "");
  return /^model\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
}

/** Reads the model list the codex CLI cached for this account, plus the default from its config. */
async function codexModels(): Promise<{ models: ModelOption[]; configured: string | null }> {
  const [cacheText, configured] = await Promise.all([readFile(path.join(codexHome(), "models_cache.json"), "utf8").catch(() => ""), codexConfiguredModel()]);
  let entries: CodexCacheEntry[] = [];
  try {
    entries = (JSON.parse(cacheText) as { models?: CodexCacheEntry[] }).models ?? [];
  } catch {
    entries = [];
  }
  const models: ModelOption[] = entries.filter((e) => e.slug && e.visibility === "list").map((e) => ({ id: e.slug!, label: e.display_name ?? e.slug! }));
  // A config.toml default the cache does not list is stale: ChatGPT sign-in would reject it on every turn.
  return { models, configured: models.some((m) => m.id === configured) ? configured : null };
}

export function createCodexCliProvider(): ProviderAdapter {
  const signIn = "Run `codex login` in a terminal, then press Check sign-in";

  /** Older Codex versions cannot report their account; fall back to the sign-in check and the cached model list. */
  async function fromCache() {
    const { models, configured } = await codexModels();
    const base = { models, freeformModels: false, defaultModel: configured ?? models[0]?.id ?? "", efforts: CLI_EFFORTS };
    try {
      const { stdout, stderr, exitCode } = await runCli({ command: bin.codex(), args: ["login", "status"], timeoutMs: STATUS_TIMEOUT_MS });
      const line = `${stdout}\n${stderr}`.split("\n").find((l) => /logged in/i.test(l))?.trim();
      if (exitCode !== 0 || !line || /not logged in/i.test(line)) return { ...base, ready: false, detail: "Not signed in", setupHint: signIn };
      if (!models.length) return { ...base, ready: false, detail: "No models listed yet", setupHint: "Run `codex` once so it downloads its model list, then press Check sign-in" };
      return { ...base, ready: true, detail: line };
    } catch (error) {
      return { ...base, ready: false, detail: (error as Error).message, setupHint: "Install Codex (npm i -g @openai/codex), run `codex login`, then press Check sign-in" };
    }
  }

  const readStatus = cached(async () => {
    try {
      const [account, configured] = await Promise.all([readCodexAccount(bin.codex(), STATUS_TIMEOUT_MS), codexConfiguredModel()]);
      const preferred = account.models.find((m) => m.id === configured) ?? account.models.find((m) => m.isDefault) ?? account.models[0];
      const models: ModelOption[] = account.models.map((m) => ({ id: m.id, label: m.label, hint: m.id === preferred?.id ? "Default" : undefined }));
      const base = { models, freeformModels: false, defaultModel: preferred?.id ?? "", efforts: CLI_EFFORTS, ...(account.plan ? { plan: account.plan } : {}) };
      if (!account.signedIn) return { ...base, ready: false, detail: "Not signed in", setupHint: signIn };
      if (!models.length) return { ...base, ready: false, detail: "Your account lists no models", setupHint: signIn };
      return { ...base, ready: true, detail: "Signed in with ChatGPT" };
    } catch {
      return fromCache();
    }
  });

  const status = async (fresh?: boolean) => {
    const result = await readStatus(fresh);
    const models = result.models.map((m) => (codexRefused.has(m.id) ? { ...m, hint: undefined, unavailable: "Not available with your ChatGPT sign-in" } : m));
    const usable = models.filter((m) => !m.unavailable);
    return { ...result, models, defaultModel: usable.find((m) => m.id === result.defaultModel)?.id ?? usable[0]?.id ?? "" };
  };

  return {
    id: "codex-cli",
    label: "Codex",
    status,
    async generate({ system, prompt, model, effort, signal }) {
      if (codexRefused.has(model)) throw new ProviderError(`Codex cannot use "${model}" with your ChatGPT sign-in. Pick another Codex model.`, false);
      // Read-only sandbox in an empty temp folder, no user config, nothing saved; the final message is read from -o.
      const workDir = await mkdtemp(path.join(tmpdir(), "uplink-codex-"));
      const out = path.join(workDir, "last-message.txt");
      const args = ["exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "--color", "never", "-C", workDir, "-o", out, "-m", model];
      if (effort && effort !== "default") args.push("-c", `model_reasoning_effort="${effort}"`);
      args.push(`${system}\n\n${prompt}`);
      try {
        const { stderr, exitCode } = await runCli({ command: bin.codex(), args, timeoutMs: CALL_CEILING_MS, signal });
        const reply = await readFile(out, "utf8").catch(() => "");
        if (reply.trim()) return reply;
        if (EXPIRED_CODEX.test(stderr))
          throw new ProviderError("Your Codex sign-in has expired. Run `codex logout` and then `codex login` in a terminal, then retry this turn.", false);
        if (UNSUPPORTED_CODEX.test(stderr)) {
          codexRefused.add(model);
          throw new ProviderError(`Codex cannot use "${model}" with your ChatGPT sign-in. Pick another Codex model.`, false);
        }
        const err = stderr
          .split("\n")
          .reverse()
          .find((l) => l.startsWith("ERROR:"))
          ?.replace(/^ERROR:\s*/, "");
        const detail = err ?? (lastLines(stderr) || `exit code ${exitCode}`);
        throw new ProviderError(`Codex returned no answer: ${detail}`, /rate.?limit|timeout|stream|disconnect|5\d\d/i.test(detail));
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        rethrow(error, signal);
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
