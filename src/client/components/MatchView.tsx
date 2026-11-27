import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ProviderInfo } from "../../ai/protocol";
import { getMap } from "../../engine/maps";
import type { MatchRecord } from "../../engine/record";
import type { Side } from "../../engine/types";
import type { MatchRunner } from "../../runner/MatchRunner";
import { modelLabel } from "../lib/format";
import type { Battlefield } from "../scene/Battlefield";
import { ConfirmButton } from "./ConfirmButton";
import { PlayerPlate, StatusLine } from "./Hud";
import { Icon } from "./Icon";
import { DelaySlider } from "./MatchSettings";
import { ResultCard, type SeriesSummary } from "./ResultCard";
import { TurnFeed } from "./TurnFeed";
import { TurnInspector } from "./TurnInspector";

interface Props {
  runner: MatchRunner;
  battlefield: Battlefield | null;
  providers: ProviderInfo[];
  series: SeriesSummary | null;
  nextIn: number | null;
  muted: boolean;
  onToggleMute: () => void;
  onNext?: () => void;
  onRestart: () => void;
  onRematch: () => void;
  onReplay: (record: MatchRecord) => void;
  onExport: (record: MatchRecord) => void;
  onSetup: () => void;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

export function MatchView({ runner, battlefield, providers, series, nextIn, muted, onToggleMute, onNext, onRestart, onRematch, onReplay, onExport, onSetup }: Props) {
  const snap = useSyncExternalStore(runner.subscribe, runner.getSnapshot);
  const { phase, state, record, thinking, executing } = snap;
  const [selected, setSelected] = useState<number | null>(null);
  const [resultHidden, setResultHidden] = useState(false);
  const players = record.players;
  const names = useMemo(() => ({ A: players.A.name, B: players.B.name }), [players]);
  const finished = phase === "over" || phase === "stopped";
  const running = !finished && phase !== "ready";
  const canPause = running && phase !== "paused" && phase !== "error" && !snap.pausePending;

  // The battlefield can be re-created mid-match (a live code reload does it), and a new one starts empty:
  // draw the current state on it and keep the runner animating there.
  useEffect(() => {
    const { players } = runner.config;
    battlefield?.setMatch(runner.board, runner.config.rules, runner.getSnapshot().state, { A: players.A.color, B: players.B.color }, { A: players.A.name, B: players.B.name });
    runner.setPresenter(battlefield);
  }, [runner, battlefield]);

  // The faint destination tiles show the decision space only while a model is actually deciding.
  useEffect(() => {
    if (!battlefield) return;
    battlefield.showThinking(phase === "thinking" && thinking ? thinking.side : null, phase === "thinking" ? state : null);
  }, [battlefield, phase, thinking, state]);

  const selectedTurn = selected !== null ? (record.turns.find((t) => t.turn === selected) ?? null) : null;
  useEffect(() => {
    if (!battlefield || phase === "executing") return;
    battlefield.previewTurn(selectedTurn);
  }, [battlefield, selectedTurn, phase]);

  useEffect(() => setResultHidden(false), [record.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (phase === "paused" || phase === "error") runner.resume();
        else if (canPause) runner.pause();
      } else if (e.key === "r" || e.key === "R") battlefield?.rotate(1);
      else if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runner, battlefield, phase, canPause]);

  const recharging = (side: Side) => !state.result && state.robots[side].recharging;
  const showResult = finished && !!record.result && !resultHidden;

  return (
    <>
      <div className="hud">
        <PlayerPlate
          side="A"
          player={players.A}
          modelText={modelLabel(players.A, providers)}
          robot={state.robots.A}
          rules={record.rules}
          active={!finished && state.active === "A"}
          thinkingSince={phase === "thinking" && thinking?.side === "A" ? thinking.since : null}
          executing={phase === "executing" && executing?.side === "A"}
          recharging={recharging("A")}
        />
        <div className="hud-center">
          <StatusLine snap={snap} names={names} />
          <p className="hud-map">
            {getMap(record.mapId).name}
            {series ? ` · Game ${series.game}/${series.of}` : ""}
          </p>
        </div>
        <PlayerPlate
          side="B"
          player={players.B}
          modelText={modelLabel(players.B, providers)}
          robot={state.robots.B}
          rules={record.rules}
          active={!finished && state.active === "B"}
          thinkingSince={phase === "thinking" && thinking?.side === "B" ? thinking.since : null}
          executing={phase === "executing" && executing?.side === "B"}
          recharging={recharging("B")}
        />
      </div>

      <div className="stage-layer">
        {phase === "error" && snap.error && (
          <div className="banner banner--error" role="alert">
            <Icon name="alert" />
            <div>
              <p className="banner-title">
                {players[snap.error.side].name} could not decide (turn {state.turn})
              </p>
              <p>{snap.error.message}</p>
              {!!snap.error.attempts?.length && (
                <ul className="banner-attempts">
                  {snap.error.attempts.map((a, i) => (
                    <li key={i}>
                      Attempt {i + 1}: <span className={a.kind === "provider" || a.kind === "timeout" ? "err" : "warn"}>{a.kind}</span> — {a.error}
                    </li>
                  ))}
                </ul>
              )}
              <p className="fine">{snap.error.retryable ? "This looks temporary. Retry asks the same model again with the same state." : "This needs a setup change (key, model id or provider). Retry after fixing it, or stop the match."}</p>
            </div>
            <div className="banner-actions">
              <button type="button" className="btn btn--primary btn--sm" onClick={() => runner.retry()}>
                Retry turn
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => runner.stop()}>
                Stop match
              </button>
            </div>
          </div>
        )}
        {showResult && (
          <ResultCard
            record={record}
            providers={providers}
            series={series}
            nextIn={nextIn}
            onNext={onNext}
            onRematch={onRematch}
            onReplay={() => onReplay(record)}
            onExport={() => onExport(record)}
            onSetup={onSetup}
            onDismiss={() => setResultHidden(true)}
          />
        )}
      </div>

      <div className="dock" role="toolbar" aria-label="Match controls">
        {finished ? (
          <>
            {resultHidden && (
              <button type="button" className="btn btn--primary btn--sm" onClick={() => setResultHidden(false)}>
                <Icon name="flag" size={16} /> Show result
              </button>
            )}
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => onReplay(record)} disabled={!record.turns.length}>
              <Icon name="eye" size={16} /> Replay
            </button>
          </>
        ) : phase === "paused" || phase === "error" ? (
          <button type="button" className="btn btn--primary btn--sm" onClick={() => runner.resume()} title="Resume (Space)">
            <Icon name="play" size={16} /> {phase === "error" ? "Retry" : "Resume"}
          </button>
        ) : (
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => runner.pause()} disabled={!canPause} title="Pause (Space)">
            <Icon name="pause" size={16} /> {snap.pausePending ? "Pausing…" : "Pause"}
          </button>
        )}
        {!finished && (
          <>
            <ConfirmButton className="btn btn--ghost btn--sm" confirmLabel="Confirm stop" onConfirm={() => runner.stop()} title="End the match now; it is saved as unfinished">
              <Icon name="stop" size={14} /> Stop
            </ConfirmButton>
            <ConfirmButton className="btn btn--ghost btn--sm" confirmLabel="Confirm restart" onConfirm={onRestart} title="Start this match again from turn 1">
              <Icon name="restart" size={16} /> Restart
            </ConfirmButton>
          </>
        )}
        <span className="dock-sep" aria-hidden="true" />
        <DelaySlider compact value={snap.delayMs} onChange={(ms) => runner.setDelay(ms)} />
        <span className="dock-sep" aria-hidden="true" />
        <button type="button" className="btn btn--ghost btn--icon" onClick={() => battlefield?.rotate(1)} aria-label="Rotate view (R)" title="Rotate view (R)">
          <Icon name="rotate" />
        </button>
        <button type="button" className="btn btn--ghost btn--icon" onClick={onToggleMute} aria-label={muted ? "Unmute sound" : "Mute sound"} aria-pressed={muted} title={muted ? "Unmute" : "Mute"}>
          <Icon name={muted ? "mute" : "volume"} />
        </button>
      </div>

      <aside className="side" aria-label="Match log">
        {selectedTurn ? (
          <TurnInspector turn={selectedTurn} players={players} board={runner.board} onClose={() => setSelected(null)} />
        ) : (
          <div className="side-head">
            <h2 className="side-title">Action log</h2>
            <p className="fine">Select an action to inspect what changed.</p>
          </div>
        )}
        <div className="side-scroll">
          <TurnFeed turns={record.turns} players={players} board={runner.board} selected={selected} onSelect={setSelected} live={phase === "thinking" ? thinking : null} />
        </div>
      </aside>
    </>
  );
}
