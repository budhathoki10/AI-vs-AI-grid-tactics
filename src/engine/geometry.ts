import type { Board, Coord, TileKind } from "./types";

export const coordKey = (c: Coord): string => `${c[0]},${c[1]}`;
export const sameCoord = (a: Coord, b: Coord): boolean => a[0] === b[0] && a[1] === b[1];

export function inBounds(board: Board, c: Coord): boolean {
  return c[0] >= 0 && c[1] >= 0 && c[0] < board.width && c[1] < board.height && Number.isInteger(c[0]) && Number.isInteger(c[1]);
}

export function tileAt(board: Board, c: Coord): TileKind | null {
  return inBounds(board, c) ? board.tiles[c[1]][c[0]] : null;
}

/** Robots can stand on and walk through floor and uplink tiles. */
export function isPassable(board: Board, c: Coord): boolean {
  const tile = tileAt(board, c);
  return tile === "floor" || tile === "uplink";
}

/** Range is measured in king steps: max(|dx|, |dy|). */
export function chebyshev(a: Coord, b: Coord): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

export function manhattan(a: Coord, b: Coord): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

/** Fixed neighbour order (N, E, S, W) keeps pathfinding deterministic. */
const STEPS: readonly Coord[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * Every tile reachable in at most `range` orthogonal steps, with the shortest path to it.
 * Walls, barriers and the `blocked` tile (the other robot) cannot be entered or crossed.
 */
export function reachableTiles(board: Board, from: Coord, range: number, blocked: Coord | null): Map<string, Coord[]> {
  const paths = new Map<string, Coord[]>();
  paths.set(coordKey(from), [from]);
  let frontier: Coord[] = [from];
  for (let step = 0; step < range; step++) {
    const next: Coord[] = [];
    for (const c of frontier) {
      const path = paths.get(coordKey(c))!;
      for (const [dx, dy] of STEPS) {
        const n: Coord = [c[0] + dx, c[1] + dy];
        const key = coordKey(n);
        if (paths.has(key) || !isPassable(board, n)) continue;
        if (blocked && sameCoord(n, blocked)) continue;
        paths.set(key, [...path, n]);
        next.push(n);
      }
    }
    frontier = next;
  }
  paths.delete(coordKey(from));
  return paths;
}

const EPS = 1e-6;

/** Does the segment p0→p1 pass through the interior of the unit tile centred on `tile`? (slab test) */
function segmentHitsTile(p0: Coord, p1: Coord, tile: Coord): boolean {
  const minX = tile[0] - 0.5 + EPS;
  const maxX = tile[0] + 0.5 - EPS;
  const minY = tile[1] - 0.5 + EPS;
  const maxY = tile[1] + 0.5 - EPS;
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  if (!clip(-dx, p0[0] - minX)) return false;
  if (!clip(dx, maxX - p0[0])) return false;
  if (!clip(-dy, p0[1] - minY)) return false;
  if (!clip(dy, maxY - p0[1])) return false;
  return t0 <= t1;
}

/** Tiles (excluding both endpoints) whose interior the straight line between two tile centres crosses. */
export function tilesOnLine(board: Board, from: Coord, to: Coord): Coord[] {
  const out: Coord[] = [];
  const x0 = Math.min(from[0], to[0]);
  const x1 = Math.max(from[0], to[0]);
  const y0 = Math.min(from[1], to[1]);
  const y1 = Math.max(from[1], to[1]);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const c: Coord = [x, y];
      if (sameCoord(c, from) || sameCoord(c, to) || !inBounds(board, c)) continue;
      if (segmentHitsTile(from, to, c)) out.push(c);
    }
  }
  return out;
}

/**
 * Line of sight runs centre to centre. It is blocked by any wall the line passes through,
 * and by a "pinch": the line slipping exactly through the corner where two walls meet diagonally.
 * Grazing a single wall's corner does not block.
 */
export function hasLineOfSight(board: Board, from: Coord, to: Coord): boolean {
  if (tilesOnLine(board, from, to).some((c) => tileAt(board, c) === "wall")) return false;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (dx === 0 || dy === 0) return true;
  // Corner crossings happen where the line hits x = k + 0.5 and y = m + 0.5 at the same parameter t.
  const steps = Math.abs(dx);
  for (let i = 0; i < steps; i++) {
    const cx = Math.min(from[0], to[0]) + i + 0.5;
    const t = (cx - from[0]) / dx;
    if (t <= 0 || t >= 1) continue;
    const cy = from[1] + t * dy;
    const frac = cy - Math.floor(cy);
    if (Math.abs(frac - 0.5) > 1e-9) continue;
    const kx = Math.floor(cx);
    const ky = Math.floor(cy);
    // The four tiles around the corner (kx..kx+1, ky..ky+1). The line passes between the off-diagonal pair.
    const sameSign = Math.sign(dx) === Math.sign(dy);
    const pair: [Coord, Coord] = sameSign
      ? [
          [kx + 1, ky],
          [kx, ky + 1],
        ]
      : [
          [kx, ky],
          [kx + 1, ky + 1],
        ];
    if (tileAt(board, pair[0]) === "wall" && tileAt(board, pair[1]) === "wall") return false;
  }
  return true;
}

/** A target is in cover when the line of fire crosses a barrier that sits next to the target. */
export function isInCover(board: Board, shooter: Coord, target: Coord): boolean {
  return tilesOnLine(board, shooter, target).some((c) => tileAt(board, c) === "barrier" && chebyshev(c, target) === 1);
}

export function allTiles(board: Board): Coord[] {
  const out: Coord[] = [];
  for (let y = 0; y < board.height; y++) for (let x = 0; x < board.width; x++) out.push([x, y]);
  return out;
}
