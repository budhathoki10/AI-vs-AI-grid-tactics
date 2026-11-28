import type { ProviderInfo } from "../../ai/protocol";
import { getMap } from "../../engine/maps";
import { keyEvents, sideStats, type MatchRecord } from "../../engine/record";
import { formatMs, modelLabel, named } from "../lib/format";
import { colorName } from "../lib/palette";
import { Icon } from "./Icon";

export interface SeriesSummary {
  game: number;
  of: number;
  records: MatchRecord[];
}

interface Props {
  record: MatchRecord;
  providers: ProviderInfo[];
  series: SeriesSummary | null;
  nextIn: number | null;
  onNext?: () => void;
  onRematch: () => void;
  onReplay: () => void;
  onExport: () => void;
  onReel: () => void;
  onSetup: () => void;
  onDismiss: () => void;
}

const REASON_TITLE: Record<string, string> = {
  disabled: "Disabled",
  score: "Score target reached",
  "turn-limit": "Turn limit",
  stopped: "Stopped",
};

export function seriesTally(records: MatchRecord[]): { A: number; B: number; draws: number; unfinished: number } {
  const t = { A: 0, B: 0, draws: 0, unfinished: 0 };
  for (const r of records) {
    if (!r.result || r.result.reason === "stopped") t.unfinished++;
    else if (r.result.winner) t[r.result.winner]++;
    else t.draws++;
  }
  return t;
}

export function ResultCard({ record, providers, series, nextIn, onNext, onRematch, onReplay, onExport, onReel, onSetup, onDismiss }: Props) {
  const result = record.result!;
  const players = record.players;
  const winner = result.winner;
  const final = record.turns.at(-1)?.stateAfter ?? record.initialState;
  const moments = keyEvents(record, (s) => players[s].name).slice(0, 7);
  const headline = result.reason === "stopped" ? "Match stopped" : winner ? `${players[winner].name} wins` : "Draw";
  const tally = series ? seriesTally(series.records) : null;

  return (
    <section className="result" role="dialog" aria-modal="false" aria-labelledby="result-title" style={winner ? ({ "--team": players[winner].color } as React.CSSProperties) : undefined}>
      <button type="button" className="btn btn--ghost btn--icon result-close" onClick={onDismiss} aria-label="Hide result and look at the board">
        <Icon name="close" />
      </button>
      <p className="eyebrow">
        {REASON_TITLE[result.reason]}
        {series ? ` · Game ${series.game} of ${series.of}` : ""}
      </p>
      <h2 id="result-title" className={`result-title${winner ? " has-winner" : ""}`}>
        {headline}
      </h2>
      <p className="result-detail">{named(result.detail, players)}</p>

      <div className="result-meta">
        <span>{getMap(record.mapId).name}</span>
        <span className="tabular">{record.turns.length} actions</span>
        <span className="tabular">{formatMs(record.durationMs)}</span>
        <span>{players[record.firstSide].name} moved first</span>
      </div>

      <div className="result-sides">
        {(["A", "B"] as const).map((side) => {
          const p = players[side];
          const stats = sideStats(record, side);
          const robot = final.robots[side];
          return (
            <div key={side} className={`result-side${winner === side ? " is-winner" : ""}`} style={{ "--team": p.color } as React.CSSProperties}>
              <div className="result-side-head">
                <span className="team-chip" aria-hidden="true" />
                <div>
                  <h3>{p.name}</h3>
                  <p className="plate-model">
                    {modelLabel(p, providers)} · {colorName(p.color)}
                  </p>
                </div>
              </div>
              <dl className="stats">
                <div>
                  <dt>Points</dt>
                  <dd className="tabular">{robot.score}</dd>
                </div>
                <div>
                  <dt>HP left</dt>
                  <dd className="tabular">{robot.hp}</dd>
                </div>
                <div>
                  <dt>Damage dealt</dt>
                  <dd className="tabular">{stats.damageDealt}</dd>
                </div>
                <div>
                  <dt>Avg decision</dt>
                  <dd className="tabular">{formatMs(stats.avgDecisionMs)}</dd>
                </div>
                <div>
                  <dt>Rejected replies</dt>
                  <dd className="tabular">{stats.retries}</dd>
                </div>
                <div>
                  <dt>Fallbacks</dt>
                  <dd className="tabular">{stats.fallbacks}</dd>
                </div>
              </dl>
              <p className="result-mix tabular">
                {stats.actions.move} moves · {stats.actions.fire} shots · {stats.actions.brace} braces · {stats.actions.overwatch} overwatch
              </p>
            </div>
          );
        })}
      </div>

      {moments.length > 0 && (
        <div className="result-moments">
          <h4>Key moments</h4>
          <ol>
            {moments.map((m, i) => (
              <li key={i} style={m.side ? ({ "--team": players[m.side].color } as React.CSSProperties) : undefined}>
                <span className="tabular">T{m.turn}</span> {m.text}
              </li>
            ))}
          </ol>
        </div>
      )}

      {tally && series && (
        <div className="result-series">
          <h4>Series so far</h4>
          <p className="tabular">
            <b style={{ color: players.A.color }}>{players.A.name}</b> {tally.A} – {tally.B} <b style={{ color: players.B.color }}>{players.B.name}</b>
            {tally.draws > 0 && ` · ${tally.draws} draw${tally.draws > 1 ? "s" : ""}`}
          </p>
          <p className="fine">Alternates first move and start tiles. Results describe play in Uplink Duel only, not general model ability.</p>
        </div>
      )}

      <p className="fine">Saved to match history in this browser.</p>

      <div className="result-actions">
        {onNext ? (
          <button type="button" className="btn btn--primary" onClick={onNext}>
            <Icon name="play" /> Next game{nextIn !== null ? ` (${nextIn})` : ""}
          </button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={onRematch} title="Same models, sides swapped for first move">
            <Icon name="restart" /> Rematch, other side first
          </button>
        )}
        <button type="button" className="btn btn--secondary" onClick={onReplay}>
          <Icon name="eye" /> Replay
        </button>
        {record.turns.length > 0 && (
          <button type="button" className="btn btn--secondary" onClick={onReel}>
            <Icon name="video" /> Download reel
          </button>
        )}
        <button type="button" className="btn btn--secondary" onClick={onExport}>
          <Icon name="download" /> Export JSON
        </button>
        <button type="button" className="btn btn--ghost" onClick={onSetup}>
          New setup
        </button>
      </div>
    </section>
  );
}
