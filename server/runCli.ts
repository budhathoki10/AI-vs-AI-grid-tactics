import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface CliRunOptions {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const MAX_CAPTURE_BYTES = 2_000_000;

export class CliError extends Error {
  constructor(
    message: string,
    readonly kind: "missing" | "timeout" | "aborted" | "failed",
  ) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * On Windows npm installs CLIs as `.cmd` shims, which Node will not spawn without a shell — and a shell would let
 * prompts or model ids be read as shell syntax. The shim only forwards to a JavaScript file, so that file is run with Node directly.
 */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): { file: string; prefix: string[] } {
  if (/\.(c|m)?js$/.test(command)) return { file: process.execPath, prefix: [command] };
  if (process.platform !== "win32") return { file: command, prefix: [] };
  const dirs = (env.PATH ?? env.Path ?? "").split(";").filter(Boolean);
  for (const dir of dirs) {
    const exe = path.join(dir, `${command}.exe`);
    if (existsSync(exe)) return { file: exe, prefix: [] };
    const shim = path.join(dir, `${command}.cmd`);
    if (existsSync(shim)) {
      const match = /"%dp0%\\([^"]+\.js)"/i.exec(readFileSync(shim, "utf8"));
      if (match) return { file: process.execPath, prefix: [path.join(dir, match[1])] };
    }
  }
  return { file: command, prefix: [] };
}

/** Runs a CLI without a shell. stdin is closed at once because both CLIs otherwise wait on it. */
export function runCli({ command, args, cwd, timeoutMs, signal }: CliRunOptions): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CliError(`${command} was cancelled`, "aborted"));
    const target = resolveCommand(command);
    const child = spawn(target.file, [...target.prefix, ...args], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const kill = () => {
      if (child.exitCode === null) child.kill();
    };
    const onAbort = () => {
      kill();
      finish(() => reject(new CliError(`${command} was cancelled`, "aborted")));
    };
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new CliError(`${command} did not answer within ${Math.round(timeoutMs / 1000)}s`, "timeout")));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      const missing = error.code === "ENOENT";
      finish(() => reject(new CliError(missing ? `${command} CLI is not installed or not on PATH` : `${command} failed to start: ${error.message}`, missing ? "missing" : "failed")));
    });
    child.on("close", (exitCode) => finish(() => resolve({ stdout, stderr, exitCode })));
  });
}

export const lastLines = (text: string, count = 4): string => text.trim().split("\n").slice(-count).join("\n");
