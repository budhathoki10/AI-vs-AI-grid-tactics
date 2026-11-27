import { useEffect, useState } from "react";
import type { PlayerConfig } from "../../ai/protocol";
import { describeAction } from "../../engine/engine";
import type { RobotState, RulesConfig, Side } from "../../engine/types";
import type { RunnerSnapshot } from "../../runner/MatchRunner";
import { formatMs, named } from "../lib/format";
import { Icon } from "./Icon";

/** Re-renders only itself ten times a second while a model is thinking. */
export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(t);
  }, []);
  return <span className="tabular">{((now - since) / 1000).toFixed(1)}s</span>;
}

interface PlateProps {
  side: Side;
  player: PlayerConfig;
  modelText: string;
  robot: RobotState;
  rules: RulesConfig;
  active: boolean;
  thinkingSince: number | null;
  executing: boolean;
  recharging: boolean;
}

export function PlayerPlate({ side, player, modelText, robot, rules, active, thinkingSince, executing, recharging }: PlateProps) {
  const pips = Array.from({ length: rules.maxHp }, (_, i) => i < robot.hp);
  const scorePct = Math.min(100, (robot.score / rules.scoreToWin) * 100);
  return (
    <section className={`plate${active ? " is-active" : ""}${robot.hp <= 0 ? " is-down" : ""}`} data-side={side} style={{ "--team": player.color } as React.CSSProperties} aria-label={`Robot ${side}: ${player.name}`}>
      <div className="plate-top">
        <div className="plate-id">
          <span className="plate-side">{side}</span>
          <div className="plate-names">
            <h3 className="plate-name">{player.name}</h3>
            <p className="plate-model">{modelText}</p>
          </div>
        </div>
        <div className="plate-score" aria-label={`${robot.score} of ${rules.scoreToWin} points`}>
          <span className="plate-score-num tabular">{robot.score}</span>
          <span className="plate-score-of">/{rules.scoreToWin}</span>
        </div>
      </div>
      <div className="plate-bars">
        <div className="hp" role="meter" aria-label="Hit points" aria-valuemin={0} aria-valuemax={rules.maxHp} aria-valuenow={robot.hp}>
          {pips.map((on, i) => (
            <span key={i} className={`hp-pip${on ? " on" : ""}`} />
          ))}
        </div>
        <span className="hp-text tabular">{robot.hp} HP</span>
      </div>
      <div className="score-track" aria-hidden="true">
        <span style={{ width: `${scorePct}%` }} />
      </div>
      <div className="plate-status">
        {thinkingSince !== null ? (
          <span className="plate-thinking">
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            Thinking <Elapsed since={thinkingSince} />
          </span>
        ) : executing ? (
          <span className="plate-thinking">Executing</span>
        ) : (
          <span className="plate-idle">{robot.hp <= 0 ? "Disabled" : active ? "Up next" : "Waiting"}</span>
        )}
        <span className="chips">
          {robot.braced && (
            <span className="chip" title="Damage taken reduced until its next turn">
              <Icon name="shield" size={13} /> Braced
            </span>
          )}
          {robot.overwatch && (
            <span className="chip" title="Will fire at the enemy if it ends a move in sight">
              <Icon name="radar" size={13} /> Overwatch
            </span>
          )}
          {recharging && (
            <span className="chip chip--muted" title="Used a stance last turn: must move or fire">
              Recharging
            </span>
          )}
        </span>
      </div>
    </section>
  );
}

export function StatusLine({ snap, names }: { snap: RunnerSnapshot; names: Record<Side, string> }) {
  const { phase, state, thinking, executing, error, pausePending, holdingDecision } = snap;
  const turn = Math.min(state.turn, snap.record.rules.turnLimit);
  let text: React.ReactNode;
  let tone = "";
  if (phase === "thinking" && thinking) {
    text = (
      <>
        <b style={{ color: snap.record.players[thinking.side].color }}>{names[thinking.side]}</b> is thinking · <Elapsed since={thinking.since} />
        {pausePending && <span className="status-sub"> — pausing after this decision</span>}
      </>
    );
  } else if (phase === "executing" && executing) {
    text = (
      <>
        <b style={{ color: snap.record.players[executing.side].color }}>{names[executing.side]}</b> · {describeAction(executing.action)}
        {executing.fallback && <span className="status-sub"> (engine fallback)</span>}
      </>
    );
  } else if (phase === "waiting") {
    text = (
      <>
        Next: <b style={{ color: snap.record.players[state.active].color }}>{names[state.active]}</b>
      </>
    );
  } else if (phase === "paused") {
    text = holdingDecision ? "Paused · decision received, not yet executed" : "Paused";
    tone = "is-paused";
  } else if (phase === "error" && error) {
    text = `${names[error.side]}: ${error.message}`;
    tone = "is-error";
  } else if (phase === "ready") text = "Ready";
  else if (phase === "over" || phase === "stopped") text = state.result ? named(state.result.detail, snap.record.players) : "Match over";

  return (
    <div className={`status-line ${tone}`}>
      <span className="status-turn tabular">
        Turn {turn}
        <span className="status-of">/{snap.record.rules.turnLimit}</span>
      </span>
      <span className="status-text">{text}</span>
      <span className="sr-only" aria-live="polite">
        {announcement(snap, names)}
      </span>
    </div>
  );
}

/** A timer-free sentence for screen readers, so the live region only speaks when something changes. */
function announcement(snap: RunnerSnapshot, names: Record<Side, string>): string {
  const { phase, thinking, executing, error, state } = snap;
  if (phase === "thinking" && thinking) return `Turn ${thinking.turn}. ${names[thinking.side]} is thinking.`;
  if (phase === "executing" && executing) return `${names[executing.side]}: ${describeAction(executing.action)}.`;
  if (phase === "paused") return "Match paused.";
  if (phase === "error" && error) return `Error for ${names[error.side]}: ${error.message}`;
  if ((phase === "over" || phase === "stopped") && state.result) return named(state.result.detail, snap.record.players);
  return "";
}

export { formatMs };
