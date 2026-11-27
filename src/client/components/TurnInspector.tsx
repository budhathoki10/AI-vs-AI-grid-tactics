import type { PlayerConfig } from "../../ai/protocol";
import type { TurnRecord } from "../../engine/record";
import type { Board, GameEvent, GameState, Side } from "../../engine/types";
import { actionLabel, eventLines, formatMs } from "../lib/format";
import { Icon } from "./Icon";
import { MiniBoard, shotOf } from "./MiniBoard";

interface Props {
  turn: TurnRecord;
  players: Record<Side, PlayerConfig>;
  board: Board;
  onClose: () => void;
}

type Change = { label: string; before: string; after: string; side?: Side };

function changes(board: Board, before: GameState, after: GameState, players: Record<Side, PlayerConfig>): Change[] {
  const out: Change[] = [];
  for (const side of ["A", "B"] as const) {
    const a = before.robots[side];
    const b = after.robots[side];
    const who = players[side].name;
    if (a.pos.join() !== b.pos.join()) out.push({ side, label: `${who} position`, before: a.pos.join(","), after: b.pos.join(",") });
    if (a.hp !== b.hp) out.push({ side, label: `${who} HP`, before: String(a.hp), after: String(b.hp) });
    if (a.score !== b.score) out.push({ side, label: `${who} points`, before: String(a.score), after: String(b.score) });
    const stance = (r: typeof a) => [r.braced && "braced", r.overwatch && "overwatch"].filter(Boolean).join(", ") || "none";
    if (stance(a) !== stance(b)) out.push({ side, label: `${who} stance`, before: stance(a), after: stance(b) });
  }
  for (const u of board.uplinks) {
    const o1 = before.owners[u.id];
    const o2 = after.owners[u.id];
    if (o1 !== o2) out.push({ label: u.name, before: o1 ? players[o1].name : "unowned", after: o2 ? players[o2].name : "unowned", side: o2 ?? undefined });
  }
  return out;
}

export function TurnInspector({ turn, players, board, onClose }: Props) {
  const colors = { A: players.A.color, B: players.B.color };
  const name = (s: Side) => players[s].name;
  const moved = turn.events.find((e): e is Extract<GameEvent, { kind: "moved" }> => e.kind === "moved");
  const shot = shotOf(turn.events, turn.stateBefore, turn.stateAfter);
  const diff = changes(board, turn.stateBefore, turn.stateAfter, players);
  const consequences = eventLines(turn.events, name, (id) => board.uplinks.find((u) => u.id === id)?.name ?? id);

  return (
    <section className="inspector" aria-labelledby="inspector-title" style={{ "--team": players[turn.side].color } as React.CSSProperties}>
      <header className="inspector-head">
        <div>
          <p className="eyebrow">
            Turn {turn.turn} · {name(turn.side)}
          </p>
          <h3 id="inspector-title">{actionLabel(turn.action)}</h3>
        </div>
        <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close turn details">
          <Icon name="close" />
        </button>
      </header>

      <dl className="facts">
        <div>
          <dt>Legal</dt>
          <dd className={turn.legal ? "ok" : "err"}>{turn.legal ? "Yes, model's own action" : "No, engine fallback"}</dd>
        </div>
        <div>
          <dt>Decision time</dt>
          <dd className="tabular">{formatMs(turn.decisionMs)}</dd>
        </div>
        <div>
          <dt>Retries</dt>
          <dd className="tabular">{turn.attempts.length}</dd>
        </div>
      </dl>

      <div className="inspector-block">
        <h4>Model's explanation</h4>
        {turn.explanation ? <blockquote className="quote">{turn.explanation}</blockquote> : <p className="muted">The model did not give one. Only the action and its observable result are shown.</p>}
        <p className="fine">This is the model's own short explanation, not verified internal reasoning.</p>
      </div>

      <div className="mini-pair">
        <MiniBoard board={board} state={turn.stateBefore} colors={colors} label="Before" />
        <MiniBoard board={board} state={turn.stateAfter} colors={colors} label="After" path={moved?.path} shotFrom={shot?.from} shotTo={shot?.to} />
      </div>

      <div className="inspector-block">
        <h4>What happened</h4>
        {consequences.length ? (
          <ul className="bullets">
            {consequences.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">No observable effect.</p>
        )}
      </div>

      {diff.length > 0 && (
        <div className="inspector-block">
          <h4>State changes</h4>
          <table className="diff">
            <tbody>
              {diff.map((d, i) => (
                <tr key={i} style={d.side ? ({ "--team": players[d.side].color } as React.CSSProperties) : undefined}>
                  <th scope="row">{d.label}</th>
                  <td className="tabular">{d.before}</td>
                  <td aria-hidden="true">→</td>
                  <td className="tabular strong">{d.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {turn.attempts.length > 0 && (
        <div className="inspector-block">
          <h4>Rejected attempts</h4>
          <ol className="attempts">
            {turn.attempts.map((a, i) => (
              <li key={i}>
                <p>
                  <span className={`flag ${a.kind === "provider" || a.kind === "timeout" ? "flag--err" : "flag--warn"}`}>{a.kind}</span> {a.error}
                  <span className="muted tabular"> · {formatMs(a.durationMs)}</span>
                </p>
                {a.excerpt && <code className="excerpt">{a.excerpt}</code>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
