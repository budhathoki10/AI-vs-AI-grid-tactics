import type { RulesConfig } from "./types";

export const RULES_VERSION = 1;

export const DEFAULT_RULES: RulesConfig = {
  maxHp: 12,
  moveRange: 2,
  fireRange: 4,
  fireDamage: 3,
  overwatchDamage: 2,
  coverReduction: 1,
  braceReduction: 2,
  minDamage: 1,
  scoreToWin: 20,
  turnLimit: 60,
};

export const TURN_LIMIT_OPTIONS = [40, 60, 80] as const;

/** Short rules text, shared by the AI prompt and the in-app rules sheet so both always agree. */
export function rulesSummary(rules: RulesConfig): string[] {
  return [
    `Strict alternating turns. On your turn you take exactly ONE action, then the opponent takes one.`,
    `MOVE: walk up to ${rules.moveRange} orthogonal steps over floor/uplink tiles. Walls (#), barriers (=) and the other robot cannot be entered or passed through.`,
    `FIRE: hit the enemy for ${rules.fireDamage} damage if it is within ${rules.fireRange} tiles (range = max(|dx|,|dy|)) and in line of sight. Walls block sight; barriers do not.`,
    `COVER: if the line of fire crosses a barrier adjacent to the target, damage is reduced by ${rules.coverReduction}.`,
    `BRACE: until the start of your next turn, damage you take is reduced by ${rules.braceReduction}.`,
    `OVERWATCH: until the start of your next turn, if the enemy ENDS a move within your range and sight, you automatically hit it for ${rules.overwatchDamage} (cover applies). Fires once.`,
    `RECHARGE: Brace and Overwatch are stances. After using either one, your next action must be MOVE or FIRE.`,
    `Damage is never below ${rules.minDamage}. A robot at 0 HP is disabled and loses. Robots start with ${rules.maxHp} HP and never heal.`,
    `UPLINKS: end any action standing on an uplink to capture it. It stays yours until the enemy captures it. At the end of each of your turns you score the value of every uplink you own (Prime = 2, others = 1).`,
    `First to ${rules.scoreToWin} points wins. After ${rules.turnLimit} total actions, higher score wins, then higher HP; otherwise it is a draw.`,
  ];
}
