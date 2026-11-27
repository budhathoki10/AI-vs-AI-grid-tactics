import { memo } from "react";
import type { Board, Coord, GameEvent, GameState, Side } from "../../engine/types";

const CELL = 14;

/** A compact top-down map of one state, with the turn's path drawn on it. */
export const MiniBoard = memo(function MiniBoard({
  board,
  state,
  colors,
  path,
  shotFrom,
  shotTo,
  label,
}: {
  board: Board;
  state: GameState;
  colors: Record<Side, string>;
  path?: Coord[];
  shotFrom?: Coord;
  shotTo?: Coord;
  label: string;
}) {
  const w = board.width * CELL;
  const h = board.height * CELL;
  const center = (c: Coord) => [c[0] * CELL + CELL / 2, c[1] * CELL + CELL / 2] as const;
  return (
    <figure className="mini">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
        {board.tiles.map((row, y) =>
          row.map((kind, x) => {
            const uplink = kind === "uplink" ? board.uplinks.find((u) => u.at[0] === x && u.at[1] === y) : null;
            const owner = uplink ? state.owners[uplink.id] : null;
            return (
              <g key={`${x},${y}`}>
                <rect x={x * CELL + 0.5} y={y * CELL + 0.5} width={CELL - 1} height={CELL - 1} rx={1.5} className={`mini-tile mini-${kind}`} />
                {uplink && <circle cx={x * CELL + CELL / 2} cy={y * CELL + CELL / 2} r={uplink.value > 1 ? 4.2 : 3.4} fill="none" strokeWidth={1.6} stroke={owner ? colors[owner] : "#cfd6df"} />}
              </g>
            );
          }),
        )}
        {path && path.length > 1 && (
          <polyline points={path.map((c) => center(c).join(",")).join(" ")} fill="none" stroke="#fff" strokeOpacity={0.75} strokeWidth={1.4} strokeDasharray="2 2" />
        )}
        {shotFrom && shotTo && <line x1={center(shotFrom)[0]} y1={center(shotFrom)[1]} x2={center(shotTo)[0]} y2={center(shotTo)[1]} stroke="#ffd9a8" strokeWidth={1.4} />}
        {(["A", "B"] as const).map((side) => {
          const [cx, cy] = center(state.robots[side].pos);
          return (
            <g key={side}>
              <circle cx={cx} cy={cy} r={4.6} fill={colors[side]} stroke="#0b0d10" strokeWidth={1.2} opacity={state.robots[side].hp > 0 ? 1 : 0.35} />
              {state.robots[side].braced && <circle cx={cx} cy={cy} r={6.4} fill="none" stroke={colors[side]} strokeWidth={0.9} />}
            </g>
          );
        })}
      </svg>
      <figcaption>{label}</figcaption>
    </figure>
  );
});

export function shotOf(events: GameEvent[], before: GameState, after: GameState): { from: Coord; to: Coord } | null {
  const shot = events.find((e): e is Extract<GameEvent, { kind: "fired" }> => e.kind === "fired");
  if (!shot) return null;
  return { from: after.robots[shot.side].pos ?? before.robots[shot.side].pos, to: after.robots[shot.target].pos };
}
