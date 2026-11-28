# Uplink Duel

Two AI models, one robot each, strictly alternating turns on an isometric tactics battlefield. Each turn the active model receives the full game state and its legal actions, answers with exactly one action plus an optional short explanation, and the engine validates and plays it out before the opponent sees the new state.

The point is to watch how models read a board, use cover, anticipate a reply and trade risk for points. Results describe performance under these rules and maps only; they are not a measure of general intelligence.

## Quick start

Requires Node 20.10+ (developed on Node 22).

```bash
npm install
npm run dev          # http://127.0.0.1:8787  (server + Vite in one process)
```

The built-in **mock** models need no API key, so a complete match runs out of the box. Pick an AI, a model and a colour for each robot, then press **Start match**. Robots are named after their model.

Production:

```bash
npm run build        # type-check + client bundle into dist/
npm start            # serves dist/ and the API on http://127.0.0.1:8787
```

Set `PORT` / `HOST` to change the address (`HOST=0.0.0.0` exposes it on your network; the API spends your provider quota, so only do that on a trusted network).

## Configuring model providers

**No key needed if you are signed in to a CLI.** Like the AI-vs-AI football project, the server detects a signed-in Claude Code (`claude auth status`) and Codex (`codex login status`) and calls them directly. They are run without a shell (on Windows the npm `.cmd` shim is resolved to its JavaScript file), so prompts and model ids can never be read as shell syntax. Set `CLAUDE_BIN` / `CODEX_BIN` to use a different binary. If Codex says your sign-in expired, run `codex logout` then `codex login`.

Each robot can use **Claude** (your Claude subscription), **Codex** (your ChatGPT subscription), **OpenRouter** (your API key, any model) or the built-in **Practice** bots. The setup screen shows which are ready; after signing in, press **Check sign-in**.

### Adding your OpenRouter key

Either way works, as in the AI Chess reference:

- **In the app.** Open **Settings**, paste the key, press **Save**. The key is stored only in this browser (`localStorage`). It is sent to your local server with OpenRouter turns only, and the server passes it to OpenRouter. It is never part of match history or exports. **Remove key** deletes it.
- **On the server.** Set `OPENROUTER_API_KEY` in `.env` and restart. If a key is also saved in Settings, the browser's key is used.

Anything that can run script on this page, such as a browser extension, can read a key saved in the browser. Use a key with a spending limit.

| Provider | Setup | Models |
| --- | --- | --- |
| **Claude** | `claude auth login` | Claude Haiku / Sonnet / Opus 5.5 and Fable 5.2, with effort. Shows your plan; **Check which models work** sends one tiny request to each and disables the ones your account is refused (also learned during a match, remembered until the server restarts). Runs `claude -p` with no tools, user settings or MCP, nothing saved. |
| **Codex** | `codex login` | The models and ChatGPT plan Codex reports for your account (`codex app-server`; older versions fall back to `~/.codex/models_cache.json`), with effort. Models your plan refuses are remembered and marked. Runs `codex exec` read-only in an empty temp folder. |
| **OpenRouter** | Key in Settings or `OPENROUTER_API_KEY` | Search the whole catalogue by name, with prices; any typed id is accepted. Decisions models are asked one multiple-choice question over the legal actions, and their explanation reports the probabilities. |
| Practice (built-in mock) | none | Tactician, Sentinel, Aggressor, Opportunist, Wildcard (random) and Glitch (sometimes sends broken replies, to exercise retries). |

The providers below appear in the app only once the server can use them (set the variable in `.env`, or have Ollama running):

| Provider | Variables | Notes |
| --- | --- | --- |
| Anthropic API | `ANTHROPIC_API_KEY` | Official SDK, `effort: "medium"`, server-side refusal fallback where supported. |
| OpenAI API | `OPENAI_API_KEY`, optional `OPENAI_BASE_URL` | Chat Completions. |
| Google Gemini | `GEMINI_API_KEY` | `generateContent` with JSON output. |
| Ollama (local) | optional `OLLAMA_BASE_URL` | Detected automatically when running; lists installed models. |
| Any OpenAI-compatible endpoint | `CUSTOM_OPENAI_BASE_URL`, `CUSTOM_OPENAI_API_KEY`, `CUSTOM_OPENAI_MODELS`, `CUSTOM_OPENAI_LABEL` | Groq, Together, LM Studio, vLLM, … |

Adding a provider means adding one adapter in `server/providers/` and registering it in `registry.ts`. The engine, decision pipeline and UI do not change.

## The rules

| | |
| --- | --- |
| Board | 9×9. Floor, **pillars** (block movement and sight), **barriers** (block movement, not sight; give cover), **uplinks**. Two point-symmetric maps: Foundry Yard and Crossfire Basin. |
| Turn | Exactly one action, then the opponent acts. |
| Move | Up to 2 orthogonal steps; cannot pass walls, barriers or the other robot. |
| Fire | 3 damage if the enemy is within 4 tiles (`max(|dx|,|dy|)`) and in line of sight. |
| Cover | −1 damage when the line of fire crosses a barrier next to the target. |
| Brace | −2 damage taken until your next turn. |
| Overwatch | Until your next turn, if the enemy *ends a move* in your range and sight, it takes 2 damage (cover applies). Fires once. |
| Recharge | After Brace or Overwatch, the next action must be Move or Fire (unless neither is possible). Prevents endless turtling. |
| Damage | Never below 1. Robots have 12 HP, no healing; 0 HP = disabled = loss. |
| Uplinks | End an action on one to capture it; it stays yours until taken. At the end of each of your turns you score its value (Prime 2, flanks 1). |
| End | Disable the enemy, reach 20 points, or after 60 total actions (configurable 40/60/80): more points wins, then more HP, else draw. |

Line of sight runs centre to centre. A wall blocks it if the line passes through the wall's interior or slips exactly between two diagonally touching walls; grazing a single corner does not block.

Balance was tuned with `npx tsx scripts/balance.ts`, which plays 120 mock-vs-mock games across both maps. With these rules the first mover wins about 50–53% of decided games and matches average about 25 actions.

## How a turn works

```
MatchRunner (browser)                       Server                          Provider
─────────────────────                       ──────                          ────────
state ─► POST /api/decide {state, turn, epoch} ─► validate request
                                                 build snapshot + prompt ──► model
                                                 parse reply ◄────────────── text
                                                 engine.validateAction
                                                 retry with the rejection reason (≤ N)
        ◄── {action, explanation, attempts} ────
validate again locally
applyAction → events
await battlefield.present(events)   (animation finishes)
commit new state, save turn
viewing delay
next side ─► POST /api/decide with the updated state …
```

- **One loop, one request.** `MatchRunner` (`src/runner/MatchRunner.ts`) runs a single async loop per *epoch*. Every await is followed by an epoch check, so an answer that arrives after Stop/Restart is discarded. The server's `DecisionGate` also refuses a duplicate `(match, epoch, turn)` with 409 and cancels a superseded request.
- **The engine is authoritative.** `src/engine/` is pure and deterministic. Legality is checked on the server *and* again in the browser before anything is applied.
- **Pause** takes effect at a safe point. A decision already in flight is held and executed after Resume, so no tokens are wasted and no state goes stale. **Stop** aborts the request (the server aborts the provider call too).
- **Errors.** Malformed or illegal replies are sent back with the reason, up to the configured retries (default 2). If every reply is unusable the engine plays a deterministic safe fallback (brace, or a move out of sight while recharging), flagged in the log. Provider errors (missing key, unknown model, network, timeouts after retries) pause the match with the message and each attempt listed, plus **Retry turn** and **Stop**.

### What a model receives

`buildSnapshot` / `buildPrompt` in `src/engine/snapshot.ts`: the rules, both robots' status, uplink ownership and income, an ASCII map with coordinates, the last 10 actions, and every legal destination annotated with engine-computed facts (can the enemy fire there, cover, can I fire from there, would it trigger overwatch). The model must reply with one JSON object:

```json
{"action":"move","to":[3,4],"explanation":"Into cover next to the prime uplink."}
```

`fire`, `brace` and `overwatch` take no target. The parser also tolerates code fences, chatter and a few field aliases. Explanations are shown as **the model's explanation**. They are never invented: if a model gives none, the log says so.

## Viewer features

- Setup: AI, model and colour per robot (colours too close to each other are blocked); map, turn delay, turn limit, first mover, single game or 2/4/6-game series; retries and timeout under Advanced.
- Match: live HUD (HP, points, stances, thinking timer), action log with each model's explanation, result, retries and decision time; select any action to inspect before/after mini-maps, state changes and rejected attempts.
- Controls: pause/resume (Space), stop, restart, live turn-delay slider, rotate view (R), mute. Sound is synthesized with Web Audio (no audio files).
- Result: winner and exact reason, per-side stats, key moments, series standing; rematch with the other side first.
- Reel video: **Download reel** (on the result card, in history and in replay) renders a stored match as a 1080×1920 MP4 for Instagram, with both models, scores, HP, each action with the model's explanation, the result and optional sound effects. It is encoded in the browser (WebCodecs, via mediabunny), so nothing is uploaded; thinking time is left out and three paces set the length. It needs a browser that can encode H.264, such as Chrome or Edge.
- History: the last 40 matches are saved in the browser. Replay step by step, export and import JSON, and see head-to-head tallies by model.

## Match records

`src/engine/record.ts` defines a versioned format (`format: "uplink-duel/match"`, `version: 1`) holding players, rules, initial state and, per turn: the action, explanation, legality, fallback flag, every rejected attempt, decision time, events and the state before and after. `verifyReplay` re-applies all actions with the engine and checks every stored state, so imported or edited files that do not match the rules are detected. `upgradeRecord` is where future versions get migrated.

## Series from the command line

```bash
npm run series -- --a=mock/tactician --b=mock/sentinel --games=6 --map=basin
npm run series -- --a=anthropic/claude-opus-5-5 --b=openai/gpt-5-mini --games=4
```

Games alternate the first mover and trade start tiles in pairs to cancel setup advantages. Records are written to `matches/`.

## Tests

```bash
npm test             # 103 unit/integration tests (vitest)
npm run typecheck
npm run smoke        # with the app running (first time: npx playwright install chromium): real-browser run of setup → full match → result → replay → history,
                     # at 1440×900, 820×1180 and 390×844; screenshots in artifacts/, fails on console errors or overflow
```

Covered: legal and illegal moves, the Claude Code and Codex CLI adapters (argv, no shell, expired sign-in, refused models), provider HTTP error mapping, line of sight and cover, every action and the recharge rule, scoring and all end conditions, reply parsing, retries with reasons, fallback, timeouts, cancellation, setup errors, request validation, duplicate and stale requests (gate and HTTP 409), keys never appearing in API output, the browser's OpenRouter key (sent with OpenRouter turns only, validated, never echoed or logged), decisions models and the model catalogue, strict turn order with one request in flight, the state handed between turns, pause holding a decision, stop discarding late answers, complete mock matches on both maps, record JSON round-trips and tamper detection, and series planning.

## Project layout

```
src/engine/     rules, maps, geometry, snapshot/prompt, reply parser, match records   (pure, shared)
src/ai/         protocol types and the mock opponents
src/runner/     MatchRunner: turn orchestration (framework-free)
src/client/     React UI and the three.js battlefield (src/client/scene/)
server/         HTTP API, decision pipeline, provider adapters
scripts/        series CLI, balance simulator, browser smoke test
```

Stack: Vite + React + TypeScript, plain three.js driven imperatively (no per-frame React renders), and a dependency-free Node HTTP server. All 3D assets (tiles, pillars, barriers, uplinks, robots, effects) are built procedurally in code, so there are no third-party art assets.

## Design notes: what came from the AI Chess reference

The [rjach/ai-chess](https://github.com/rjach/ai-chess) repository was studied for model handling. Adapted ideas: OpenRouter keys saved in the browser from a Settings dialog, a searchable OpenRouter catalogue including decisions models, CLI sign-in detection with a re-check button; a stateless decision endpoint fed the full position plus a legal-move list; provider adapters behind one `generate()` interface with a `retryable` flag on errors; lenient parsing of a requested JSON shape; re-prompting with the rejection reason; a flagged fallback after repeated bad replies while provider failures pause the match; and request cancellation tied to the browser connection. Deliberate differences: orchestration lives in a framework-free runner with epoch guards instead of a React effect; the server also refuses duplicate turns; and the fallback is a deterministic safe action rather than a random move.

## Known limitations

- **Visual reference.** The brief mentions a screenshot as the visual target, but none was included with the request or in the project folder. The battlefield follows the written direction instead (isometric diorama, chunky bevelled tiles, cover, robot scale, lighting). If you share the screenshot, the palette, tile proportions, camera angle and props can be matched to it.
- The 3D view needs WebGL. Without it the match still runs and the log and inspector work, and a notice is shown.
- Model lists for the OpenAI and Gemini APIs are a short fixed set. Real-provider calls were not exercised here because no API keys were available. They are covered by unit tests with fake providers and by a live run against an unreachable endpoint (error path).
- Mock opponents are small heuristics (one- or two-ply search), meant for trying the game and for tests, not as strong baselines.
- Match history lives in browser `localStorage` (last 40 matches); export JSON to keep matches permanently.
