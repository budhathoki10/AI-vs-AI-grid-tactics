import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProviderInfo } from "../../ai/protocol";
import { buildBoard, getMap } from "../../engine/maps";
import { verifyReplay, type MatchRecord } from "../../engine/record";
import { modelLabel, named } from "../lib/format";
import type { Battlefield } from "../scene/Battlefield";
import { PlayerPlate } from "./Hud";
import { Icon } from "./Icon";
import { TurnFeed } from "./TurnFeed";
import { TurnInspector } from "./TurnInspector";

interface Props {
  record: MatchRecord;
  battlefield: Battlefield | null;
  providers: ProviderInfo[];
  onExit: () => void;
  onExport: () => void;
}

const SPEEDS = [0.5, 1, 2] as const;

/**
 * Step-by-step replay of a stored match. States are recomputed with the engine from the recorded
 * actions, so the replay also proves the record is consistent with the rules.
 */
export function ReplayView({ record, battlefield, providers, onExit, onExport }: Props) {
  const board = useMemo(() => buildBoard(getMap(record.mapId), record.swapStarts), [record]);
  const check = useMemo(() => verifyReplay(record), [record]);
  const states = useMemo(() => [record.initialState, ...record.turns.map((t) => t.stateAfter)], [record]);
  const total = record.turns.length;
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [selected, setSelected] = useState<number | null>(null);
  const busy = useRef(false);
  const indexRef = useRef(0);
  indexRef.current = index;

  useEffect(() => {
    if (!battlefield) return;
    battlefield.setMatch(board, record.rules, record.initialState, { A: record.players.A.color, B: record.players.B.color }, { A: record.players.A.name, B: record.players.B.name });
    battlefield.showThinking(null, null);
    setIndex(0);
  }, [battlefield, board, record]);

  const jump = useCallback(
    (i: number) => {
      const next = Math.max(0, Math.min(total, i));
      battlefield?.interrupt();
      battlefield?.sync(states[next]);
      setIndex(next);
    },
    [battlefield, states, total],
  );

  const stepForward = useCallback(async () => {
    if (busy.current || !battlefield) return;
    const i = indexRef.current;
    if (i >= total) return;
    busy.current = true;
    battlefield.sync(states[i]);
    await battlefield.present(record.turns[i]);
    busy.current = false;
    setIndex(i + 1);
  }, [battlefield, record, states, total]);

  // Autoplay: animate a turn, wait, repeat. Cancelled by pausing, scrubbing or leaving.
  useEffect(() => {
    if (!playing) return;
    if (index >= total) {
      setPlaying(false);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(async () => {
      if (cancelled) return;
      await stepForward();
    }, 450 / speed);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [playing, index, total, speed, stepForward]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" && (el as HTMLInputElement).type !== "range") return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setPlaying(false);
        void stepForward();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPlaying(false);
        jump(indexRef.current - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jump, stepForward]);

  const state = states[index];
  const plate = (side: "A" | "B") => (
    <PlayerPlate
      side={side}
      player={record.players[side]}
      modelText={modelLabel(record.players[side], providers)}
      robot={state.robots[side]}
      rules={record.rules}
      active={!state.result && state.active === side}
      thinkingSince={null}
      executing={false}
      recharging={!state.result && state.robots[side].recharging}
    />
  );
  const selectedTurn = selected !== null ? (record.turns.find((t) => t.turn === selected) ?? null) : null;

  return (
    <>
      <div className="hud">
        {plate("A")}
        <div className="hud-center hud-center--replay">
          <div className="status-line">
            <span className="status-turn tabular">
              Replay · {index}
              <span className="status-of">/{total}</span>
            </span>
            <span className="status-text">{index === total && record.result ? named(record.result.detail, record.players) : index === 0 ? "Starting positions" : `After turn ${index}`}</span>
          </div>
          {!check.ok && (
            <p className="hud-map hud-warn">
              <Icon name="alert" size={14} /> Record diverges from the rules at turn {check.divergedAt}; showing stored states.
            </p>
          )}
        </div>
        {plate("B")}
      </div>

      <div className="dock dock--replay" role="toolbar" aria-label="Replay controls">
        <button type="button" className="btn btn--ghost btn--icon" onClick={() => (setPlaying(false), jump(0))} aria-label="Back to start" disabled={index === 0}>
          <Icon name="skipBack" />
        </button>
        <button type="button" className="btn btn--ghost btn--icon" onClick={() => (setPlaying(false), jump(index - 1))} aria-label="Previous turn (Left arrow)" disabled={index === 0}>
          <Icon name="chevronLeft" />
        </button>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => (index >= total ? (jump(0), setPlaying(true)) : setPlaying((p) => !p))} aria-label={playing ? "Pause replay" : "Play replay"}>
          <Icon name={playing ? "pause" : "play"} size={16} /> {playing ? "Pause" : index >= total ? "Replay again" : "Play"}
        </button>
        <button type="button" className="btn btn--ghost btn--icon" onClick={() => (setPlaying(false), void stepForward())} aria-label="Next turn (Right arrow)" disabled={index >= total}>
          <Icon name="chevronRight" />
        </button>
        <input
          className="scrub"
          type="range"
          min={0}
          max={total}
          value={index}
          aria-label="Replay position"
          aria-valuetext={`Turn ${index} of ${total}`}
          onChange={(e) => {
            setPlaying(false);
            jump(Number(e.target.value));
          }}
        />
        <div className="segmented segmented--sm" role="radiogroup" aria-label="Replay speed">
          {SPEEDS.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={speed === s} className="segmented-item" onClick={() => setSpeed(s)}>
              {s}×
            </button>
          ))}
        </div>
        <span className="dock-sep" aria-hidden="true" />
        <button type="button" className="btn btn--ghost btn--icon" onClick={() => battlefield?.rotate(1)} aria-label="Rotate view">
          <Icon name="rotate" />
        </button>
        <button type="button" className="btn btn--ghost btn--icon" onClick={onExport} aria-label="Export match JSON">
          <Icon name="download" />
        </button>
        <button type="button" className="btn btn--secondary btn--sm" onClick={onExit}>
          Exit replay
        </button>
      </div>

      <aside className="side" aria-label="Replay log">
        {selectedTurn ? (
          <TurnInspector turn={selectedTurn} players={record.players} board={board} onClose={() => setSelected(null)} />
        ) : (
          <div className="side-head">
            <h2 className="side-title">Replay log</h2>
            <p className="fine">Select an action to jump there and inspect it.</p>
          </div>
        )}
        <div className="side-scroll">
          <TurnFeed
            turns={record.turns}
            players={record.players}
            board={board}
            selected={selected}
            cursor={index || null}
            onSelect={(turn) => {
              setSelected(turn);
              if (turn !== null) {
                setPlaying(false);
                jump(turn);
              }
            }}
          />
        </div>
      </aside>
    </>
  );
}
