import { getMap } from "../../engine/maps";
import type { MatchRecord, TurnRecord } from "../../engine/record";
import type { GameState, Side } from "../../engine/types";
import { actionLabel, named } from "../lib/format";
import type { SceneOverlay } from "../scene/Battlefield";
import { ellipsize, REEL_HEIGHT, REEL_WIDTH, wrapText } from "./reel";

/** The battlefield's area inside the frame. */
export const BOARD = { x: 0, y: 510, width: REEL_WIDTH, height: 860 };

// Instagram covers the top and bottom of a reel, and its buttons sit on the lower right, so text stays inside these.
const LEFT = 60;
const RIGHT = REEL_WIDTH - 60;
const CAPTION_RIGHT = REEL_WIDTH - 150;

const DISPLAY = '"Barlow Condensed", "Barlow", sans-serif';
const BODY = '"Barlow", sans-serif';

export interface Frame {
  record: MatchRecord;
  /** "Provider · Model" for each side. */
  models: Record<Side, string>;
  scene: HTMLCanvasElement;
  overlay: SceneOverlay;
  state: GameState;
  /** The turn on screen; null before the first one. */
  turn: TurnRecord | null;
  card: "intro" | "outro" | null;
}

export async function loadReelFonts(): Promise<void> {
  await Promise.all([`600 60px ${DISPLAY}`, `400 36px ${BODY}`, `500 36px ${BODY}`, `600 36px ${BODY}`].map((f) => document.fonts.load(f)));
}

function text(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = "left"): void {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(value, x, y);
}

function fit(ctx: CanvasRenderingContext2D, value: string, width: number, font: string): string {
  ctx.font = font;
  return ellipsize((s) => ctx.measureText(s).width, value, width);
}

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string, stroke?: string): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 20);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}

function playerCard(ctx: CanvasRenderingContext2D, f: Frame, side: Side, x: number, y: number, w: number): void {
  const player = f.record.players[side];
  const robot = f.state.robots[side];
  const hp = f.overlay.plates.find((p) => p.side === side)?.hp ?? robot.hp;
  const acting = f.turn?.side === side;
  panel(ctx, x, y, w, 210, "rgba(18,21,25,0.94)", acting ? player.color : "rgba(255,255,255,0.1)");
  ctx.fillStyle = player.color;
  ctx.fillRect(x + 24, y + 26, 10, 62);
  const nameFont = `600 46px ${DISPLAY}`;
  text(ctx, fit(ctx, player.name, w - 76, nameFont), x + 52, y + 60, nameFont, "#eceef1");
  const modelFont = `400 24px ${BODY}`;
  text(ctx, fit(ctx, f.models[side], w - 76, modelFont), x + 52, y + 92, modelFont, "#9aa1ac");
  text(ctx, String(robot.score), x + 24, y + 160, `600 62px ${DISPLAY}`, player.color);
  ctx.font = `600 62px ${DISPLAY}`;
  const scoreWidth = ctx.measureText(String(robot.score)).width;
  text(ctx, `/ ${f.record.rules.scoreToWin} pts`, x + 34 + scoreWidth, y + 160, `500 26px ${BODY}`, "#9aa1ac");
  text(ctx, `${hp} HP`, x + w - 24, y + 160, `600 30px ${BODY}`, "#eceef1", "right");
  const bar = w - 48;
  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.fillRect(x + 24, y + 178, bar, 10);
  ctx.fillStyle = player.color;
  ctx.fillRect(x + 24, y + 178, bar * Math.max(0, Math.min(1, hp / f.record.rules.maxHp)), 10);
}

function sceneLayer(ctx: CanvasRenderingContext2D, f: Frame): void {
  ctx.drawImage(f.scene, BOARD.x, BOARD.y, BOARD.width, BOARD.height);
  for (const plate of f.overlay.plates) {
    const player = f.record.players[plate.side];
    const font = `600 28px ${DISPLAY}`;
    const label = fit(ctx, player.name, 260, font);
    const width = ctx.measureText(label).width + 26;
    const x = BOARD.x + plate.x;
    const y = BOARD.y + plate.y;
    panel(ctx, x - width / 2, y - 52, width, 38, "rgba(11,13,16,0.82)");
    text(ctx, label, x, y - 23, font, "#ffffff", "center");
    ctx.fillStyle = "rgba(11,13,16,0.82)";
    ctx.fillRect(x - 44, y - 10, 88, 8);
    ctx.fillStyle = player.color;
    ctx.fillRect(x - 44, y - 10, 88 * Math.max(0, plate.hp / f.record.rules.maxHp), 8);
  }
  for (const floater of f.overlay.floaters) {
    const x = BOARD.x + floater.x + 70;
    const y = BOARD.y + floater.y - floater.age * 70;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, floater.age * 7, (1 - floater.age) * 4));
    ctx.shadowColor = "rgba(0,0,0,0.75)";
    ctx.shadowBlur = 14;
    const color = floater.kind === "damage" ? "#ffd2c2" : f.record.players[floater.side].color;
    const size = floater.kind === "damage" ? 68 : floater.kind === "score" ? 52 : 34;
    text(ctx, floater.kind === "tag" ? floater.text.toUpperCase() : floater.text, x, y, `600 ${size}px ${DISPLAY}`, color, "center");
    if (floater.sub) text(ctx, floater.sub.toUpperCase(), x, y + 30, `600 22px ${BODY}`, "#ffe1bd", "center");
    ctx.restore();
  }
}

function caption(ctx: CanvasRenderingContext2D, f: Frame): void {
  const turn = f.turn;
  if (!turn) return;
  const player = f.record.players[turn.side];
  const y = 1390;
  const width = CAPTION_RIGHT - LEFT;
  const head = `600 48px ${DISPLAY}`;
  const name = fit(ctx, player.name, width * 0.6, head);
  text(ctx, name, LEFT, y + 40, head, player.color);
  const after = LEFT + ctx.measureText(name).width + 22;
  text(ctx, actionLabel(turn.action) + (turn.fallback ? " (fallback)" : ""), after, y + 40, `600 36px ${BODY}`, "#eceef1");
  // The model's own words; nothing is written for it when it gave none.
  const words = turn.explanation ? `“${turn.explanation}”` : "No explanation given.";
  ctx.font = `400 36px ${BODY}`;
  wrapText((s) => ctx.measureText(s).width, words, width, 4).forEach((line, i) => text(ctx, line, LEFT, y + 100 + i * 48, `400 36px ${BODY}`, turn.explanation ? "#d3d7de" : "#858c97"));
}

function card(ctx: CanvasRenderingContext2D, f: Frame): void {
  // Dims everything under the player cards, fading in so the board's area has no visible edge.
  const top = BOARD.y - 10;
  const dim = f.card === "intro" ? 0.62 : 0.74;
  const shade = ctx.createLinearGradient(0, top, 0, top + 140);
  shade.addColorStop(0, "rgba(8,10,12,0)");
  shade.addColorStop(1, `rgba(8,10,12,${dim})`);
  ctx.fillStyle = shade;
  ctx.fillRect(0, top, REEL_WIDTH, REEL_HEIGHT - top);
  const middle = BOARD.y + BOARD.height / 2;
  const max = RIGHT - LEFT;
  const big = (value: string, y: number, color: string, size = 96) => {
    const font = `600 ${size}px ${DISPLAY}`;
    text(ctx, fit(ctx, value, max, font), REEL_WIDTH / 2, y, font, color, "center");
  };
  if (f.card === "intro") {
    big(f.record.players.A.name, middle - 80, f.record.players.A.color);
    big("vs", middle + 20, "#9aa1ac", 60);
    big(f.record.players.B.name, middle + 130, f.record.players.B.color);
    text(ctx, "Two AI models. One battlefield.", REEL_WIDTH / 2, middle + 230, `500 36px ${BODY}`, "#d3d7de", "center");
    return;
  }
  const result = f.record.result;
  const winner = result?.winner ? f.record.players[result.winner] : null;
  big(winner ? winner.name : result?.reason === "stopped" ? "Match stopped" : "Draw", middle - 60, winner?.color ?? "#eceef1", 110);
  if (winner) big("wins", middle + 50, "#eceef1", 80);
  ctx.font = `500 36px ${BODY}`;
  wrapText((s) => ctx.measureText(s).width, named(result?.detail ?? "", f.record.players), max, 3).forEach((line, i) => text(ctx, line, REEL_WIDTH / 2, middle + 140 + i * 50, `500 36px ${BODY}`, "#d3d7de", "center"));
}

export function drawFrame(ctx: CanvasRenderingContext2D, f: Frame): void {
  const background = ctx.createRadialGradient(REEL_WIDTH / 2, BOARD.y + BOARD.height / 2, 60, REEL_WIDTH / 2, BOARD.y + BOARD.height / 2, 1150);
  background.addColorStop(0, "#3a3f49");
  background.addColorStop(0.45, "#1b1f26");
  background.addColorStop(1, "#0b0d10");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, REEL_WIDTH, REEL_HEIGHT);
  ctx.textBaseline = "alphabetic";

  sceneLayer(ctx, f);
  text(ctx, "Uplink Duel", REEL_WIDTH / 2, 190, `600 72px ${DISPLAY}`, "#eceef1", "center");
  const turnLine = f.turn ? `Turn ${f.turn.turn} of ${f.record.rules.turnLimit} · ${getMap(f.record.mapId).name}` : `AI vs AI tactics · ${getMap(f.record.mapId).name}`;
  text(ctx, turnLine, REEL_WIDTH / 2, 240, `500 32px ${BODY}`, "#9aa1ac", "center");
  const width = (RIGHT - LEFT - 24) / 2;
  playerCard(ctx, f, "A", LEFT, 280, width);
  playerCard(ctx, f, "B", LEFT + width + 24, 280, width);
  if (f.card) card(ctx, f);
  else caption(ctx, f);
}
