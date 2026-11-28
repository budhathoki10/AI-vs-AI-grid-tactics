import { describe, expect, it } from "vitest";
import type { MatchRecord } from "../../engine/record";
import { ellipsize, estimateSeconds, reelFileName, wrapText } from "./reel";

const measure = (s: string) => s.length;

describe("reel captions", () => {
  it("wraps words to the width", () => {
    expect(wrapText(measure, "move toward the prime uplink", 11, 4)).toEqual(["move toward", "the prime", "uplink"]);
    expect(wrapText(measure, "", 11, 4)).toEqual([]);
  });

  it("cuts long text on the last line with an ellipsis, never exceeding the width", () => {
    const lines = wrapText(measure, "one two three four five six seven eight nine ten", 9, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
    expect(lines.every((l) => l.length <= 9)).toBe(true);
    expect(ellipsize(measure, "a-very-long-model-identifier", 8)).toBe("a-very-…");
  });
});

describe("reel planning", () => {
  const record = { createdAt: "2026-11-27T10:00:00Z", turns: Array(20).fill({}), players: { A: { name: "Claude Haiku 5.5" }, B: { name: "GPT-6-Luna" } } } as unknown as MatchRecord;

  it("estimates a longer video for a slower pace", () => {
    expect(estimateSeconds(record, "quick")).toBeLessThan(estimateSeconds(record, "normal"));
    expect(estimateSeconds(record, "normal")).toBeLessThan(estimateSeconds(record, "relaxed"));
  });

  it("names the file after the match", () => {
    expect(reelFileName(record)).toBe("uplink-duel_claude-haiku-5-5-vs-gpt-6-luna_2026-11-27.mp4");
  });
});
