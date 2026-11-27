import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenAICompatibleProvider } from "./providers/openaiCompatible";
import { ProviderError, type GenerateRequest } from "./providers/types";

let server: Server | null = null;
afterEach(() => server?.close());

async function fakeEndpoint(handler: (body: Record<string, unknown>, req: IncomingMessage) => { status: number; body: unknown }): Promise<string> {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const { status, body } = handler(raw ? JSON.parse(raw) : {}, req);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

const request = (signal = new AbortController().signal): GenerateRequest =>
  ({ system: "sys", prompt: "your move", model: "m-1", signal, attempt: 0, context: {} }) as unknown as GenerateRequest;

describe("OpenAI-compatible adapter", () => {
  it("sends system + user messages with a bearer key and returns the reply text", async () => {
    let seen: { body: Record<string, unknown>; auth?: string } | null = null;
    const base = await fakeEndpoint((body, req) => {
      seen = { body, auth: req.headers.authorization };
      return { status: 200, body: { choices: [{ message: { content: '{"action":"brace"}' } }] } };
    });
    const provider = createOpenAICompatibleProvider({ id: "x", label: "X", baseUrl: base, apiKey: "k-123", keyRequired: true, models: [], setupHint: "" });
    await expect(provider.generate(request())).resolves.toBe('{"action":"brace"}');
    expect(seen!.auth).toBe("Bearer k-123");
    expect(seen!.body).toMatchObject({ model: "m-1", messages: [{ role: "system", content: "sys" }, { role: "user", content: "your move" }] });
  });

  it.each([
    [401, false, /rejected the API key/],
    [404, false, /does not know this model/],
    [429, true, /rate limit/],
    [503, true, /server error/],
  ])("maps HTTP %i to a %s-retryable ProviderError", async (status, retryable, message) => {
    const base = await fakeEndpoint(() => ({ status, body: { error: { message: "nope" } } }));
    const provider = createOpenAICompatibleProvider({ id: "x", label: "X", baseUrl: base, apiKey: "k-123", keyRequired: true, models: [], setupHint: "" });
    const error = await provider.generate(request()).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ retryable, message: expect.stringMatching(message) });
    expect(error.message).not.toContain("k-123");
  });

  it("refuses to call out without a required key", async () => {
    const provider = createOpenAICompatibleProvider({ id: "x", label: "X", baseUrl: "http://127.0.0.1:9/v1", keyRequired: true, models: [], setupHint: "Set X_KEY." });
    await expect(provider.generate(request())).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/no API key/) });
    expect((await provider.status()).ready).toBe(false);
  });
});
