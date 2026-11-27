import { memo } from "react";
import type { PlayerConfig } from "../../ai/protocol";
import type { TurnRecord } from "../../engine/record";
import type { Board, Side } from "../../engine/types";
import { actionLabel, eventLines, formatMs } from "../lib/format";
import { Elapsed } from "./Hud";
import { Icon } from "./Icon";

interface Props {
  turns: TurnRecord[];
  players: Record<Side, PlayerConfig>;
  board: Board;
  selected: number | null;
  onSelect: (turn: number | null) => void;
  /** Live row shown above the history while a model is thinking. */
  live?: { side: Side; since: number; turn: number } | null;
  /** In replay, the turn the board is showing. */
  cursor?: number | null;
}

export const TurnFeed = memo(function TurnFeed({ turns, players, board, selected, onSelect, live, cursor }: Props) {
  const name = (s: Side) => players[s].name;
  const uplinkName = (id: string) => board.uplinks.find((u) => u.id === id)?.name ?? id;
  const ordered = [...turns].reverse();

  return (
    <ol className="feed" aria-label="Action history, newest first">
      {live && (
        <li className="feed-item is-live" style={{ "--team": players[live.side].color } as React.CSSProperties}>
          <div className="feed-row">
            <span className="feed-turn tabular">T{live.turn}</span>
            <span className="feed-dot" aria-hidden="true" />
            <span className="feed-who">{name(live.side)}</span>
            <span className="feed-action feed-action--muted">thinking…</span>
            <span className="feed-time">
              <Elapsed since={live.since} />
            </span>
          </div>
        </li>
      )}
      {ordered.length === 0 && !live && <li className="feed-empty">No actions yet. The first decision will appear here.</li>}
      {ordered.map((t) => {
        const isSelected = selected === t.turn;
        const lines = eventLines(t.events, name, uplinkName).filter((l) => !l.startsWith("Moved"));
        return (
          <li
            key={t.turn}
            className={`feed-item${isSelected ? " is-selected" : ""}${cursor === t.turn ? " is-cursor" : ""}`}
            style={{ "--team": players[t.side].color } as React.CSSProperties}
          >
            <button type="button" className="feed-button" aria-pressed={isSelected} onClick={() => onSelect(isSelected ? null : t.turn)}>
              <div className="feed-row">
                <span className="feed-turn tabular">T{t.turn}</span>
                <span className="feed-dot" aria-hidden="true" />
                <span className="feed-who">{name(t.side)}</span>
                <span className="feed-action">{actionLabel(t.action)}</span>
                <span className="feed-time tabular">{formatMs(t.decisionMs)}</span>
              </div>
              {t.explanation ? (
                <p className="feed-explain">
                  <span className="sr-only">Model's explanation: </span>“{t.explanation}”
                </p>
              ) : (
                !t.fallback && <p className="feed-explain feed-explain--none">No explanation given.</p>
              )}
              {lines.length > 0 && <p className="feed-result">{lines.join(" · ")}</p>}
              {(t.fallback || t.attempts.length > 0) && (
                <p className="feed-flags">
                  {t.fallback && (
                    <span className="flag flag--err">
                      <Icon name="alert" size={12} /> Engine fallback
                    </span>
                  )}
                  {t.attempts.length > 0 && (
                    <span className="flag flag--warn">
                      {t.attempts.length} rejected {t.attempts.length === 1 ? "reply" : "replies"}
                    </span>
                  )}
                </p>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
});
