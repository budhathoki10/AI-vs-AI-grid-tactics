import type { Action, Coord } from "./types";

export const MAX_EXPLANATION_CHARS = 280;

export type ParseResult = { ok: true; action: Action; explanation: string } | { ok: false; reason: string };

/** Every balanced {...} block in the text, outermost first, so fenced or chatty replies still parse. */
function jsonObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const value: unknown = JSON.parse(text.slice(start, i + 1));
          if (value && typeof value === "object" && !Array.isArray(value)) out.push(value as Record<string, unknown>);
        } catch {
          /* not JSON, keep scanning */
        }
        break;
      }
    }
  }
  return out;
}

function readCoord(value: unknown): Coord | null {
  if (Array.isArray(value) && value.length === 2) {
    const [x, y] = value.map(Number);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  }
  if (value && typeof value === "object") {
    const { x, y } = value as { x?: unknown; y?: unknown };
    const nx = Number(x);
    const ny = Number(y);
    return Number.isFinite(nx) && Number.isFinite(ny) && x !== undefined && y !== undefined ? [nx, ny] : null;
  }
  if (typeof value === "string") {
    const match = /(-?\d+)\s*[, ]\s*(-?\d+)/.exec(value);
    return match ? [Number(match[1]), Number(match[2])] : null;
  }
  return null;
}

const ACTION_ALIASES: Record<string, Action["type"]> = {
  move: "move",
  walk: "move",
  fire: "fire",
  shoot: "fire",
  attack: "fire",
  tag: "fire",
  brace: "brace",
  defend: "brace",
  guard: "brace",
  overwatch: "overwatch",
  watch: "overwatch",
};

function cleanExplanation(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_EXPLANATION_CHARS);
}

function fromObject(obj: Record<string, unknown>): ParseResult | null {
  const rawType = obj.action ?? obj.type ?? obj.move;
  if (typeof rawType !== "string") return null;
  const type = ACTION_ALIASES[rawType.trim().toLowerCase()];
  const explanation = cleanExplanation(obj.explanation ?? obj.comment ?? obj.reason ?? obj.reasoning);
  if (!type) return { ok: false, reason: `"${rawType.slice(0, 30)}" is not an action (use move, fire, brace or overwatch)` };
  if (type !== "move") return { ok: true, action: { type }, explanation };
  const to = readCoord(obj.to ?? obj.target ?? obj.destination ?? obj.tile ?? (obj.x !== undefined ? { x: obj.x, y: obj.y } : undefined));
  if (!to) return { ok: false, reason: 'a move needs "to":[x,y]' };
  return { ok: true, action: { type: "move", to }, explanation };
}

/**
 * Turns a model's free-form reply into a structured action. Legality is checked separately by the engine.
 * Accepts the requested JSON shape first, then a bare "move 3,4" / "fire" style answer.
 */
export function parseReply(text: string): ParseResult {
  if (!text || !text.trim()) return { ok: false, reason: "the reply was empty" };
  let firstFailure: ParseResult | null = null;
  for (const obj of jsonObjects(text)) {
    const parsed = fromObject(obj);
    if (parsed?.ok) return parsed;
    if (parsed && !firstFailure) firstFailure = parsed;
  }
  if (firstFailure) return firstFailure;

  const bare = /\b(move|walk|fire|shoot|attack|brace|defend|guard|overwatch)\b(?:\s*(?:to)?\s*\[?\s*(-?\d+)\s*[, ]\s*(-?\d+)\s*\]?)?/i.exec(text.slice(0, 400));
  if (bare) {
    const type = ACTION_ALIASES[bare[1].toLowerCase()];
    if (type === "move") {
      if (bare[2] === undefined) return { ok: false, reason: "a move needs a destination [x,y]" };
      return { ok: true, action: { type: "move", to: [Number(bare[2]), Number(bare[3])] }, explanation: "" };
    }
    return { ok: true, action: { type }, explanation: "" };
  }
  return { ok: false, reason: "no JSON action object was found in the reply" };
}
