import { spawn } from "node:child_process";
import { resolveCommand } from "../runCli";

export interface CodexAccount {
  signedIn: boolean;
  /** ChatGPT plan ("free", "plus", ...); null for an API-key sign-in. */
  plan: string | null;
  models: { id: string; label: string; isDefault: boolean }[];
}

interface Reply {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

interface AccountResult {
  account?: { type?: string; planType?: string } | null;
}

interface ModelListResult {
  data?: { model?: string; displayName?: string; hidden?: boolean; isDefault?: boolean }[];
}

const INIT = 1;
const ACCOUNT = 2;
const MODELS = 3;

/**
 * Asks `codex app-server` (JSON lines over stdio) who is signed in and which models that account may run.
 * Only reads: no turn is started, so nothing is billed. Rejects when this Codex version cannot answer.
 */
export function readCodexAccount(command: string, timeoutMs: number): Promise<CodexAccount> {
  return new Promise((resolve, reject) => {
    const target = resolveCommand(command);
    const child = spawn(target.file, [...target.prefix, "app-server"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const results = new Map<number, unknown>();
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn();
    };
    const fail = (message: string) => finish(() => reject(new Error(message)));
    const timer = setTimeout(() => fail("Codex did not report its account in time"), timeoutMs);
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);

    const handle = (reply: Reply) => {
      if (reply.id === undefined) return; // a notification
      if (reply.error) return fail(reply.error.message ?? "Codex refused the request");
      if (reply.id === INIT) {
        send({ method: "initialized" });
        send({ id: ACCOUNT, method: "account/read", params: { refreshToken: false } });
        send({ id: MODELS, method: "model/list", params: {} });
        return;
      }
      results.set(reply.id, reply.result);
      if (!results.has(ACCOUNT) || !results.has(MODELS)) return;
      const { account } = results.get(ACCOUNT) as AccountResult;
      const models = ((results.get(MODELS) as ModelListResult).data ?? [])
        .filter((m) => m.model && !m.hidden)
        .map((m) => ({ id: m.model!, label: m.displayName ?? m.model!, isDefault: !!m.isDefault }));
      finish(() => resolve({ signedIn: !!account, plan: account?.planType ?? null, models }));
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        try {
          handle(JSON.parse(line) as Reply);
        } catch {
          /* not a protocol line */
        }
      }
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => fail(error.message));
    child.on("close", () => fail("Codex closed before reporting its account"));
    send({ id: INIT, method: "initialize", params: { clientInfo: { name: "uplink-duel", title: "Uplink Duel", version: "1.0.0" } } });
  });
}
