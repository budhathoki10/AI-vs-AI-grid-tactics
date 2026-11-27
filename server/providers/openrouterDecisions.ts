import { rulesSummary } from "../../src/engine/rules";
import type { Snapshot } from "../../src/engine/snapshot";
import type { RulesConfig } from "../../src/engine/types";

/**
 * OpenRouter "decisions" models answer typed questions instead of chatting, so a turn is asked as one
 * `choice` question whose options are the legal actions. Option keys use only letters, digits and "_".
 */
export const ACTION_QUESTION_KEY = "action";

type Reply = { action: "move"; to: [number, number] } | { action: string };

interface LegalOption {
  reply: Reply;
  name: string;
  description: string;
}

function legalOptions(snapshot: Snapshot): Map<string, LegalOption> {
  const options = new Map<string, LegalOption>();
  for (const move of snapshot.moves) {
    const [x, y] = move.to;
    const facts = [
      move.uplink ? `captures or holds ${move.uplink}` : "",
      move.enemyCanFireHere ? `the enemy can fire at you there${move.coverFromEnemy ? " but you have cover" : ""}` : "safe from the enemy's current position",
      move.canFireAtEnemyFromHere ? "you could fire at the enemy from there next turn" : "",
      move.triggersEnemyOverwatch ? "triggers the enemy's overwatch" : "",
    ].filter(Boolean);
    options.set(`move_${x}_${y}`, { reply: { action: "move", to: [x, y] }, name: `move to [${x},${y}]`, description: `Move to [${x},${y}] (${move.steps} step${move.steps > 1 ? "s" : ""}): ${facts.join("; ")}` });
  }
  const others: Record<string, string> = {
    fire: `Fire at the enemy for ${snapshot.fire.expectedDamage ?? 0} damage`,
    brace: "Brace: take less damage until your next turn",
    overwatch: "Overwatch: damage the enemy if it ends a move in your range and sight",
  };
  for (const action of snapshot.otherActions) options.set(action, { reply: { action }, name: action, description: others[action] ?? action });
  return options;
}

export interface DecisionRequestBody {
  model: string;
  state: string;
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>;
}

export function buildDecisionRequest(model: string, rules: RulesConfig, snapshot: Snapshot): DecisionRequestBody {
  const { self, enemy, uplinks, incomePerTurn, scoreToWin, recentHistory, board } = snapshot;
  return {
    model,
    state: [
      `Uplink Duel, a turn-based tactics game. You are Robot ${snapshot.you}. Turn ${snapshot.turn} of ${snapshot.turnLimit}.`,
      "Rules:",
      ...rulesSummary(rules).map((r) => `- ${r}`),
      `State: ${JSON.stringify({ self, enemy, uplinks, incomePerTurn, scoreToWin, recentHistory })}`,
      "Map:",
      board.legend,
      ...board.rows,
    ].join("\n"),
    questions: {
      [ACTION_QUESTION_KEY]: {
        type: "choice",
        instructions: `You are Robot ${snapshot.you}. Choose the strongest action. Use cover, expect the enemy's reply, and win the uplink score race.`,
        criteria: Object.fromEntries([...legalOptions(snapshot)].map(([key, option]) => [key, option.description])),
      },
    },
  };
}

interface ChoiceAnswer {
  type?: string;
  choice?: unknown;
  probabilities?: Record<string, number>;
}

export type DecisionReading = { ok: true; reply: Reply & { explanation: string } } | { ok: false; reason: string };

const percent = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * A refusal, a missing answer, a wrong answer type or a key outside the legal set all count as "not answered".
 * Decisions models write no prose, so the explanation reports how sure the model was.
 */
export function readDecisionAnswer(body: unknown, snapshot: Snapshot): DecisionReading {
  const answer = (body as { answers?: Record<string, ChoiceAnswer> } | null)?.answers?.[ACTION_QUESTION_KEY];
  if (!answer) return { ok: false, reason: "the decisions model returned no answer" };
  if (answer.type === "refusal") return { ok: false, reason: "the decisions model refused to choose an action" };
  if (answer.type !== "choice" || typeof answer.choice !== "string") return { ok: false, reason: `unexpected answer type "${String(answer.type)}"` };

  const legal = legalOptions(snapshot);
  const chosen = legal.get(answer.choice);
  if (!chosen) return { ok: false, reason: `"${answer.choice.slice(0, 20)}" is not one of the legal actions` };

  const probability = answer.probabilities?.[answer.choice];
  const next = Object.entries(answer.probabilities ?? {})
    .filter(([key]) => key !== answer.choice && legal.has(key))
    .sort(([, a], [, b]) => b - a)[0];
  const explanation =
    probability === undefined
      ? `Decisions model: chose ${chosen.name}.`
      : `Decisions model: chose ${chosen.name} with ${percent(probability)} probability${next ? `, next best ${legal.get(next[0])!.name} ${percent(next[1])}` : ""}.`;
  return { ok: true, reply: { ...chosen.reply, explanation } };
}
