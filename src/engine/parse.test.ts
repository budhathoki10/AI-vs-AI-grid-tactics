import { describe, expect, it } from "vitest";
import { parseReply } from "./parse";

describe("parseReply", () => {
  it("reads the requested JSON shape", () => {
    expect(parseReply('{"action":"move","to":[3,4],"explanation":"Into cover."}')).toEqual({ ok: true, action: { type: "move", to: [3, 4] }, explanation: "Into cover." });
    expect(parseReply('{"action":"fire"}')).toEqual({ ok: true, action: { type: "fire" }, explanation: "" });
  });

  it("tolerates markdown fences, chatter and alternative field names", () => {
    const reply = 'Sure!\n```json\n{"type": "Move", "destination": {"x": 2, "y": 5}, "reason": "flank"}\n```';
    expect(parseReply(reply)).toEqual({ ok: true, action: { type: "move", to: [2, 5] }, explanation: "flank" });
    expect(parseReply('{"action":"defend","comment":"wait"}')).toMatchObject({ ok: true, action: { type: "brace" } });
    expect(parseReply('{"action":"move","to":"6, 1"}')).toMatchObject({ ok: true, action: { type: "move", to: [6, 1] } });
  });

  it("skips non-action objects and finds the action", () => {
    expect(parseReply('{"analysis":{"threat":true}} {"action":"overwatch"}')).toMatchObject({ ok: true, action: { type: "overwatch" } });
  });

  it("accepts a bare answer", () => {
    expect(parseReply("move to 4,2")).toMatchObject({ ok: true, action: { type: "move", to: [4, 2] } });
    expect(parseReply("I will BRACE.")).toMatchObject({ ok: true, action: { type: "brace" } });
  });

  it("explains malformed replies", () => {
    expect(parseReply("")).toEqual({ ok: false, reason: "the reply was empty" });
    expect(parseReply("Let me think about the flanking manoeuvre")).toMatchObject({ ok: false, reason: expect.stringMatching(/no JSON/) });
    expect(parseReply('{"action":"teleport"}')).toMatchObject({ ok: false, reason: expect.stringMatching(/not an action/) });
    expect(parseReply('{"action":"move"}')).toMatchObject({ ok: false, reason: expect.stringMatching(/needs/) });
    expect(parseReply('{"action":"move", "to": [1,')).toMatchObject({ ok: false });
  });

  it("caps very long explanations", () => {
    const parsed = parseReply(JSON.stringify({ action: "brace", explanation: "x".repeat(2000) }));
    expect(parsed.ok && parsed.explanation.length).toBe(280);
  });
});
