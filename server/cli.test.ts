import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCliProvider, createCodexCliProvider } from "./providers/cli";
import type { GenerateRequest } from "./providers/types";

// Stand-in CLIs: plain Node scripts that record their argv and answer like the real tools.
const dir = mkdtempSync(path.join(tmpdir(), "uplink-cli-test-"));
const argvLog = path.join(dir, "argv.json");
function script(name: string, body: string): string {
  const file = path.join(dir, `${name}.mjs`);
  writeFileSync(file, `import { writeFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nwriteFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args));\n${body}`);
  return file;
}

const request = (patch: Partial<GenerateRequest> = {}): GenerateRequest =>
  ({ system: "SYSTEM", prompt: 'say "hi"; rm -rf / && echo $HOME', model: "m-1", effort: "low", signal: new AbortController().signal, attempt: 0, context: {}, ...patch }) as unknown as GenerateRequest;

const readArgs = async (): Promise<string[]> => JSON.parse((await import("node:fs")).readFileSync(argvLog, "utf8"));

afterEach(() => {
  delete process.env.CLAUDE_BIN;
  delete process.env.CODEX_BIN;
});

describe("Claude Code CLI provider", () => {
  it("runs a tool-less, settings-free print call and returns the result text", async () => {
    process.env.CLAUDE_BIN = script("claude-ok", `console.log(JSON.stringify({ is_error: false, result: '{"action":"brace"}' }));`);
    await expect(createClaudeCliProvider().generate(request())).resolves.toBe('{"action":"brace"}');
    const args = await readArgs();
    expect(args.slice(0, 2)).toEqual(["-p", 'say "hi"; rm -rf / && echo $HOME']); // passed as one argv entry, never through a shell
    expect(args).toEqual(expect.arrayContaining(["--model", "m-1", "--system-prompt", "SYSTEM", "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--effort", "low"]));
  });

  it("reports CLI errors without retrying setup problems", async () => {
    process.env.CLAUDE_BIN = script("claude-err", `console.log(JSON.stringify({ is_error: true, result: "Invalid model name" })); process.exit(1);`);
    await expect(createClaudeCliProvider().generate(request())).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/Invalid model name/) });
  });

  it("is not ready when signed out, and re-checks when fresh is requested", async () => {
    process.env.CLAUDE_BIN = script("claude-out", `console.log(JSON.stringify({ loggedIn: false }));`);
    const provider = createClaudeCliProvider();
    expect(await provider.status()).toMatchObject({ ready: false, efforts: ["default", "low", "medium", "high"] });
    process.env.CLAUDE_BIN = script("claude-in", `console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));`);
    expect(await provider.status()).toMatchObject({ ready: false });
    expect(await provider.status(true)).toMatchObject({ ready: true });
  });
});

describe("models follow the signed-in account", () => {
  it("reports the Claude plan and disables a model the account is refused", async () => {
    process.env.CLAUDE_BIN = script(
      "claude-plan",
      `if (args[0] === "auth") console.log(JSON.stringify({ loggedIn: true, subscriptionType: "pro" }));
       else if (args[args.indexOf("--model") + 1] === "claude-fable-5-2") { console.log(JSON.stringify({ is_error: true, result: "Fable 5.2 requires usage credits." })); process.exit(1); }
       else console.log(JSON.stringify({ is_error: false, result: "ok" }));`,
    );
    const provider = createClaudeCliProvider();
    expect((await provider.status()).models.some((m) => m.unavailable)).toBe(false);
    await provider.checkModels!(new AbortController().signal);
    const status = await provider.status();
    expect(status).toMatchObject({ plan: "pro", canCheckModels: true });
    expect(status.models.filter((m) => m.unavailable)).toEqual([expect.objectContaining({ id: "claude-fable-5-2", unavailable: "Needs usage credits" })]);
  });

  it("does not disable Claude models over a rate limit", async () => {
    process.env.CLAUDE_BIN = script("claude-limit", `console.log(JSON.stringify({ is_error: true, result: "429 rate limit reached" })); process.exit(1);`);
    const provider = createClaudeCliProvider();
    await expect(provider.checkModels!(new AbortController().signal)).rejects.toMatchObject({ retryable: true });
    expect((await provider.status()).models.some((m) => m.unavailable)).toBe(false);
  });

  it("offers the models and plan Codex reports for the account", async () => {
    process.env.CODEX_BIN = script(
      "codex-account",
      `let buffer = "";
       process.stdin.on("data", (chunk) => {
         buffer += chunk;
         const lines = buffer.split("\\n"); buffer = lines.pop();
         for (const line of lines) {
           const { id, method } = JSON.parse(line);
           const result = method === "account/read" ? { account: { type: "chatgpt", planType: "free" } }
             : method === "model/list" ? { data: [{ model: "gpt-small", displayName: "GPT Small", isDefault: true }, { model: "gpt-secret", hidden: true }] } : {};
           if (id !== undefined) process.stdout.write(JSON.stringify({ id, result }) + "\\n");
         }
       });`,
    );
    expect(await createCodexCliProvider().status()).toMatchObject({ ready: true, plan: "free", defaultModel: "gpt-small", models: [{ id: "gpt-small", label: "GPT Small" }] });
  });
});

describe("Codex CLI provider", () => {
  it("runs codex exec read-only and reads the final message file", async () => {
    process.env.CODEX_BIN = script("codex-ok", `const out = args[args.indexOf("-o") + 1]; writeFileSync(out, '{"action":"overwatch"}');`);
    await expect(createCodexCliProvider().generate(request())).resolves.toBe('{"action":"overwatch"}');
    const args = await readArgs();
    expect(args).toEqual(expect.arrayContaining(["exec", "--ephemeral", "--sandbox", "read-only", "-m", "m-1", "-c", 'model_reasoning_effort="low"']));
    expect(args.at(-1)).toBe('SYSTEM\n\nsay "hi"; rm -rf / && echo $HOME');
  });

  it("explains an expired ChatGPT sign-in", async () => {
    process.env.CODEX_BIN = script("codex-expired", `console.error("ERROR codex_login: Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again."); process.exit(1);`);
    await expect(createCodexCliProvider().generate(request({ model: "m-expired" }))).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/codex login/) });
  });

  it("remembers models the sign-in cannot use", async () => {
    process.env.CODEX_BIN = script("codex-unsupported", `console.error("ERROR: The 'm-pro' model is not supported when using Codex with a ChatGPT account."); process.exit(1);`);
    const provider = createCodexCliProvider();
    await expect(provider.generate(request({ model: "m-pro" }))).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/cannot use "m-pro"/) });
    await expect(provider.generate(request({ model: "m-pro" }))).rejects.toMatchObject({ message: expect.stringMatching(/cannot use/) });
  });
});
