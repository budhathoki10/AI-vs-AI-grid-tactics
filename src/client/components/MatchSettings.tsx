import { useId, useState } from "react";
import { MAPS } from "../../engine/maps";
import { TURN_LIMIT_OPTIONS } from "../../engine/rules";
import type { SetupIssue, SetupState } from "../setup";
import { Icon } from "./Icon";
import { Segmented } from "./Segmented";

interface Props {
  setup: SetupState;
  issues: SetupIssue[];
  onChange: (patch: Partial<SetupState>) => void;
  onSwap: () => void;
  onStart: () => void;
}

export function DelaySlider({ value, onChange, compact }: { value: number; onChange: (ms: number) => void; compact?: boolean }) {
  const id = useId();
  return (
    <div className={`slider-field${compact ? " slider-field--compact" : ""}`}>
      <label htmlFor={id} className="seg-label">
        Turn delay <output htmlFor={id}>{(value / 1000).toFixed(1)} s</output>
      </label>
      <input id={id} type="range" min={0} max={4000} step={100} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

export function MatchSettings({ setup, issues, onChange, onSwap, onStart }: Props) {
  const [advanced, setAdvanced] = useState(false);
  const map = MAPS.find((m) => m.id === setup.mapId)!;
  const blocking = issues[0];

  return (
    <section className="settings" aria-label="Match settings">
      <div className="settings-grid">
        <div className="settings-map">
          <Segmented label="Battlefield" value={setup.mapId} options={MAPS.map((m) => ({ value: m.id, label: m.name }))} onChange={(mapId) => onChange({ mapId })} />
          <p className="field-hint">{map.description}</p>
        </div>
        <DelaySlider value={setup.delayMs} onChange={(delayMs) => onChange({ delayMs })} />
        <Segmented label="Turn limit" value={setup.turnLimit} options={TURN_LIMIT_OPTIONS.map((n) => ({ value: n, label: String(n) }))} onChange={(turnLimit) => onChange({ turnLimit })} />
        <Segmented
          label="First move"
          value={setup.firstSide}
          options={[
            { value: "A", label: "Robot A" },
            { value: "B", label: "Robot B" },
          ]}
          onChange={(firstSide) => onChange({ firstSide })}
        />
        <Segmented
          label="Games"
          value={setup.seriesGames}
          options={[1, 2, 4, 6].map((n) => ({ value: n, label: n === 1 ? "Single" : `${n}`, title: n === 1 ? "One match" : `${n}-game series: alternates first move and start tiles` }))}
          onChange={(seriesGames) => onChange({ seriesGames })}
        />
      </div>

      <div className="settings-actions">
        <button type="button" className="btn btn--ghost btn--sm" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
          Advanced
        </button>
        <button type="button" className="btn btn--secondary" onClick={onSwap} title="Swap the two robots' models and colours">
          <Icon name="swap" /> Swap sides
        </button>
        <button type="button" className="btn btn--primary btn--lg" onClick={onStart} disabled={!!blocking} aria-describedby={blocking ? "start-blocker" : undefined}>
          <Icon name="play" /> {setup.seriesGames > 1 ? `Start ${setup.seriesGames}-game series` : "Start match"}
        </button>
      </div>
      {blocking && (
        <p id="start-blocker" className="settings-blocker" role="status">
          <Icon name="alert" size={16} /> {blocking.side ? `Robot ${blocking.side}: ` : ""}
          {blocking.message}
        </p>
      )}

      {advanced && (
        <div className="settings-advanced">
          <Segmented label="Retries after a bad reply" value={setup.retries} options={[0, 1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))} onChange={(retries) => onChange({ retries })} />
          <Segmented label="Decision timeout" value={setup.timeoutSec} options={[30, 60, 90, 180, 300].map((n) => ({ value: n, label: `${n}s` }))} onChange={(timeoutSec) => onChange({ timeoutSec })} />
          <p className="field-hint">
            A reply that is malformed or illegal is sent back to the model with the reason. When every attempt fails the engine plays a safe fallback (brace, or a move out of sight) and marks it in the log. Provider errors such as a missing key pause the match instead.
          </p>
        </div>
      )}
    </section>
  );
}
