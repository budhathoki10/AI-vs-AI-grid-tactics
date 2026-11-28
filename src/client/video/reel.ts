import type { MatchRecord } from "../../engine/record";

/** Pure planning and text layout for the reel video. */

export const REEL_WIDTH = 1080;
export const REEL_HEIGHT = 1920;
export const FPS = 30;

export const PACES = {
  quick: { label: "Quick", lead: 0.3, read: 0.9 },
  normal: { label: "Normal", lead: 0.5, read: 1.8 },
  relaxed: { label: "Relaxed", lead: 0.7, read: 3 },
} as const;

export type Pace = keyof typeof PACES;

export const INTRO_SECONDS = 2.2;
export const OUTRO_SECONDS = 3.5;
/** Typical length of one turn's animation, used only for the estimate. */
const ANIMATION_SECONDS = 1.1;

export function estimateSeconds(record: MatchRecord, pace: Pace): number {
  const { lead, read } = PACES[pace];
  return Math.round(INTRO_SECONDS + record.turns.length * (lead + ANIMATION_SECONDS + read) + OUTRO_SECONDS);
}

/** Breaks text into at most `maxLines` lines that fit `width`, ending with an ellipsis when it is cut. */
export function wrapText(measure: (s: string) => number, text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  const words = text.trim().split(/\s+/).filter(Boolean);
  let line = "";
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (!line || measure(next) <= width) {
      line = next;
      continue;
    }
    if (lines.length === maxLines - 1) return [...lines, ellipsize(measure, `${line} ${words.slice(i).join(" ")}`, width)];
    lines.push(line);
    line = words[i];
  }
  if (line) lines.push(measure(line) <= width ? line : ellipsize(measure, line, width));
  return lines;
}

export function ellipsize(measure: (s: string) => number, text: string, width: number): string {
  if (measure(text) <= width) return text;
  let cut = text;
  while (cut.length > 1 && measure(`${cut.trimEnd()}…`) > width) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

export function reelFileName(record: MatchRecord): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `uplink-duel_${slug(record.players.A.name)}-vs-${slug(record.players.B.name)}_${record.createdAt.slice(0, 10)}.mp4`;
}
