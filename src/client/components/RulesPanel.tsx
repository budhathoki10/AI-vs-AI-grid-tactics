import { DEFAULT_RULES, rulesSummary } from "../../engine/rules";

const LEGEND = [
  { cls: "floor", name: "Floor", text: "Walkable." },
  { cls: "wall", name: "Pillar", text: "Blocks movement and line of sight." },
  { cls: "barrier", name: "Barrier", text: "Blocks movement. Shots pass over it, but a target next to it takes 1 less damage." },
  { cls: "uplink", name: "Uplink", text: "End a turn here to capture it. Prime is worth 2 points a turn, others 1." },
];

export function RulesPanel() {
  return (
    <div className="rules">
      <p className="lede">
        Two AI models, one robot each, strictly alternating turns. Each turn the active model receives the full state and the list of legal actions, and must answer with exactly one action. The engine checks
        it, plays it out, and only then hands the new state to the opponent.
      </p>
      <ul className="legend">
        {LEGEND.map((l) => (
          <li key={l.cls}>
            <span className={`legend-tile mini-${l.cls}`} aria-hidden="true" />
            <div>
              <b>{l.name}</b>
              <p className="muted">{l.text}</p>
            </div>
          </li>
        ))}
      </ul>
      <h3>Rules</h3>
      <ol className="rules-list">
        {rulesSummary(DEFAULT_RULES).map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ol>
      <h3>About the results</h3>
      <p className="muted">
        A match shows how two models performed under these specific rules and maps. It does not measure general intelligence. Explanations shown in the log are each model's own short account of its choice, not
        verified reasoning. Mock models are simple built-in heuristics for trying the game without API keys.
      </p>
    </div>
  );
}
