import { useId } from "react";
import type { PlayerConfig, ProviderInfo } from "../../ai/protocol";
import type { Side } from "../../engine/types";
import { colorDistance, MIN_COLOR_DISTANCE, TEAM_COLORS } from "../lib/palette";
import { OPENROUTER, planSummary, providerChoices, shortName, switchProvider } from "../lib/providers";
import type { SetupIssue } from "../setup";
import { ModelCombobox } from "./ModelCombobox";
import { Icon } from "./Icon";
import { Segmented } from "./Segmented";

export interface CatalogState {
  loading: boolean;
  error: string | null;
}

interface Props {
  side: Side;
  player: PlayerConfig;
  otherColor: string;
  providers: ProviderInfo[] | null;
  providersError: string | null;
  issues: SetupIssue[];
  catalog: CatalogState;
  onChange: (player: PlayerConfig) => void;
  onOpenSettings: () => void;
  onCheckModels: (providerId: string) => void;
  /** Provider whose models are being checked right now. */
  checkingModels: string | null;
}

export function RobotConfig({ side, player, otherColor, providers, providersError, issues, catalog, onChange, onOpenSettings, onCheckModels, checkingModels }: Props) {
  const uid = useId();
  const provider = providers?.find((p) => p.id === player.provider) ?? null;
  const issue = (field: SetupIssue["field"]) => issues.find((i) => i.side === side && i.field === field)?.message;
  const model = provider?.models.find((m) => m.id === player.model);
  const modelId = `${uid}-model`;
  const plan = provider && planSummary(provider);

  return (
    <section className="robot-config" style={{ "--team": player.color } as React.CSSProperties} aria-labelledby={`${uid}-title`}>
      <header className="robot-config-head">
        <span className="team-chip" aria-hidden="true" />
        <div>
          <p className="eyebrow">Robot {side}</p>
          <h2 id={`${uid}-title`} className="robot-config-title">
            {player.name}
          </h2>
        </div>
        <ProviderStatus provider={provider} loading={!providers && !providersError} />
      </header>

      <div className="field">
        <span id={`${uid}-ai`} className="seg-label">
          AI
        </span>
        {providers ? (
          <div className="providers" role="radiogroup" aria-labelledby={`${uid}-ai`}>
            {providerChoices(providers, player.provider).map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={p.id === player.provider}
                title={`${p.label}: ${p.detail}`}
                className="provider"
                onClick={() => p.id !== player.provider && onChange(switchProvider(player, p))}
              >
                <span className={`provider-dot${p.ready ? " is-ready" : ""}`} aria-hidden="true" />
                <span className="provider-name">{shortName(p)}</span>
                <span className="sr-only">{p.ready ? ", ready" : ", needs setup"}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="field-hint">{providersError ? "Server unavailable" : "Checking sign-ins…"}</p>
        )}
        {providers && !provider && <p className="field-error">Choose an AI</p>}
      </div>

      {provider && !provider.ready && (
        <div className="notice" role="status">
          <Icon name="alert" size={16} />
          {provider.id === OPENROUTER ? (
            <p>
              Add your OpenRouter API key to use these models.{" "}
              <button type="button" className="link" onClick={onOpenSettings}>
                Open Settings
              </button>
            </p>
          ) : (
            <p>
              {provider.detail}. {provider.setupHint}
            </p>
          )}
        </div>
      )}

      <div className="field">
        <label htmlFor={modelId}>Model</label>
        {provider?.id === OPENROUTER ? (
          <ModelCombobox
            id={modelId}
            value={player.model}
            // The remembered name belonged to the previous model.
            onChange={(next) => onChange({ ...player, model: next, name: "" })}
            options={provider.models}
            loading={catalog.loading}
            error={catalog.error}
            invalid={!!issue("model")}
          />
        ) : provider && (provider.models.length > 0 || !provider.freeformModels) ? (
          <select id={modelId} value={player.model} onChange={(e) => onChange({ ...player, model: e.target.value })} disabled={!provider.models.length} aria-invalid={!!issue("model")}>
            {!provider.models.length && <option value={player.model}>No models available</option>}
            {provider.models.map((m) => (
              <option key={m.id} value={m.id} disabled={!!m.unavailable}>
                {m.label}
                {m.unavailable || m.hint ? ` · ${m.unavailable ?? m.hint}` : ""}
              </option>
            ))}
          </select>
        ) : (
          <input id={modelId} value={player.model} placeholder="model id" spellCheck={false} autoComplete="off" onChange={(e) => onChange({ ...player, model: e.target.value })} aria-invalid={!!issue("model")} />
        )}
        {issue("model") ? (
          <p className="field-error">{issue("model")}</p>
        ) : (
          provider?.id === OPENROUTER && <p className="field-hint">{model ? [model.id, model.hint].filter(Boolean).join(" · ") : "Search by name, or type a model id."}</p>
        )}
        {plan && (
          <p className="field-hint">
            {plan}
            {provider.canCheckModels && (
              <>
                {" · "}
                <button type="button" className="link" disabled={!!checkingModels} title="Sends one tiny request to each model" onClick={() => onCheckModels(provider.id)}>
                  {checkingModels === provider.id ? "Checking models…" : "Check which models work"}
                </button>
              </>
            )}
          </p>
        )}
      </div>

      {provider?.efforts && (
        <div className="field">
          <Segmented
            label="Effort"
            value={player.effort ?? "default"}
            options={provider.efforts.map((e) => ({ value: e, label: e === "default" ? "Default" : e[0].toUpperCase() + e.slice(1) }))}
            onChange={(effort) => onChange({ ...player, effort })}
          />
          <p className="field-hint">Lower effort answers faster.</p>
        </div>
      )}

      <fieldset className="field">
        <legend>Team colour</legend>
        <div className="swatches" role="radiogroup" aria-label={`Robot ${side} colour`}>
          {TEAM_COLORS.map((c) => {
            const taken = colorDistance(c.hex, otherColor) < MIN_COLOR_DISTANCE;
            const selected = c.hex === player.color;
            return (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`${c.name}${taken ? " (too close to the other robot)" : ""}`}
                title={taken ? `${c.name} — too close to the other robot's colour` : c.name}
                className="swatch"
                style={{ "--swatch": c.hex } as React.CSSProperties}
                disabled={taken && !selected}
                onClick={() => onChange({ ...player, color: c.hex })}
              />
            );
          })}
        </div>
        {issue("color") && <p className="field-error">{issue("color")}</p>}
      </fieldset>
    </section>
  );
}

function ProviderStatus({ provider, loading }: { provider: ProviderInfo | null; loading: boolean }) {
  if (loading) return <span className="status-pill">Checking…</span>;
  if (!provider) return <span className="status-pill status-pill--err">Unavailable</span>;
  return (
    <span className={`status-pill ${provider.ready ? "status-pill--ok" : "status-pill--warn"}`} title={provider.detail}>
      {provider.ready ? "Ready" : "Needs setup"}
    </span>
  );
}
