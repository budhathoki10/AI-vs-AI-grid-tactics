import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelOption, ProviderInfo } from "../ai/protocol";
import { createInitialState } from "../engine/engine";
import { buildBoard, getMap } from "../engine/maps";
import type { MatchRecord } from "../engine/record";
import { DEFAULT_RULES } from "../engine/rules";
import { MatchRunner, planSeries, type MatchConfig } from "../runner/MatchRunner";
import { Dialog } from "./components/Dialog";
import { HistoryPanel } from "./components/HistoryPanel";
import { Icon } from "./components/Icon";
import { MatchSettings } from "./components/MatchSettings";
import { MatchView } from "./components/MatchView";
import { ReelPanel } from "./components/ReelPanel";
import { ReplayView } from "./components/ReplayView";
import { RobotConfig } from "./components/RobotConfig";
import { RulesPanel } from "./components/RulesPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { checkProviderModels, fetchOpenRouterModels, fetchProviders, httpDecider } from "./lib/api";
import { OPENROUTER, settlePlayer, withModelNames, withOpenRouter } from "./lib/providers";
import { sound } from "./lib/sound";
import { downloadJson, loadHistory, loadJson, loadOpenRouterKey, newId, removeFromHistory, saveJson, saveOpenRouterKey, saveToHistory } from "./lib/storage";
import { Battlefield } from "./scene/Battlefield";
import { loadSetup, saveSetup, toMatchConfig, validateSetup, type SetupState } from "./setup";

type Screen = "setup" | "match" | "replay";

interface SeriesState {
  id: string;
  configs: MatchConfig[];
  index: number;
  records: MatchRecord[];
}

const NEXT_GAME_SECONDS = 6;
const MUTE_KEY = "uplink-duel.muted";

/** The canvas host. Memoised and always the first child of the workspace, so it never remounts between screens. */
const Stage = memo(function Stage({ onReady }: { onReady: (bf: Battlefield | null, failed: boolean) => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let bf: Battlefield | null = null;
    try {
      bf = new Battlefield(host.current, { reducedMotion, onSound: (name) => sound.play(name) });
    } catch (error) {
      console.error("WebGL battlefield could not start", error);
    }
    onReady(bf, !bf);
    return () => {
      bf?.dispose();
      onReady(null, false);
    };
  }, [onReady]);
  return <div ref={host} className="stage" />;
});

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 3 29 10.5 16 18 3 10.5z" fill="#d9cdb6" />
      <path d="M3 10.5 16 18v11L3 21.5z" fill="#8f8574" />
      <path d="M29 10.5 16 18v11l13-7.5z" fill="#5f574b" />
      <circle cx="11.5" cy="10.5" r="2.4" fill="#4c7dff" />
      <circle cx="20.5" cy="10.5" r="2.4" fill="#ff5b3a" />
    </svg>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App() {
  const [setup, setSetup] = useState<SetupState>(loadSetup);
  const [serverProviders, setServerProviders] = useState<ProviderInfo[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>("setup");
  const [runner, setRunner] = useState<MatchRunner | null>(null);
  const [series, setSeries] = useState<SeriesState | null>(null);
  const [nextIn, setNextIn] = useState<number | null>(null);
  const [replay, setReplay] = useState<MatchRecord | null>(null);
  const [history, setHistory] = useState<MatchRecord[]>(loadHistory);
  const [muted, setMuted] = useState<boolean>(() => loadJson(MUTE_KEY, false));
  const [dialog, setDialog] = useState<null | "rules" | "history" | "settings" | "reel">(null);
  const [reelRecord, setReelRecord] = useState<MatchRecord | null>(null);
  const [battlefield, setBattlefield] = useState<Battlefield | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);
  const runnerRef = useRef<MatchRunner | null>(null);
  const seriesRef = useRef<SeriesState | null>(null);
  seriesRef.current = series;

  const onStageReady = useCallback((bf: Battlefield | null, failed: boolean) => {
    setBattlefield(bf);
    setWebglFailed(failed);
  }, []);

  useEffect(() => {
    sound.muted = muted;
    saveJson(MUTE_KEY, muted);
  }, [muted]);

  useEffect(() => saveSetup(setup), [setup]);

  // On wide screens the HUD and dock float over the stage; keep the board centred in the clear area between them.
  useEffect(() => {
    if (!battlefield) return;
    const apply = () => {
      const wide = window.innerWidth >= 1100;
      if (!wide) battlefield.setInsets(0, 0);
      else if (screen === "setup") battlefield.setInsets(72, 8);
      else battlefield.setInsets(150, 84);
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [battlefield, screen]);

  const [checking, setChecking] = useState(false);
  const loadProviders = useCallback((fresh: boolean, signal?: AbortSignal) => {
    setProvidersError(null);
    setChecking(true);
    fetchProviders(signal, fresh)
      .then((list) => {
        setServerProviders(list);
        setSetup((s) => ({ ...s, players: { A: settlePlayer(s.players.A, list), B: settlePlayer(s.players.B, list) } }));
      })
      .catch((error) => {
        if (!signal?.aborted) setProvidersError(errorMessage(error));
      })
      .finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    loadProviders(false, controller.signal);
    return () => controller.abort();
  }, [loadProviders]);

  const [checkingModels, setCheckingModels] = useState<string | null>(null);
  const checkModels = (providerId: string) => {
    setCheckingModels(providerId);
    setProvidersError(null);
    checkProviderModels(providerId)
      .then(({ providers: list, error }) => {
        setServerProviders(list);
        setSetup((s) => ({ ...s, players: { A: settlePlayer(s.players.A, list), B: settlePlayer(s.players.B, list) } }));
        setProvidersError(error);
      })
      .catch((error) => setProvidersError(errorMessage(error)))
      .finally(() => setCheckingModels(null));
  };

  const [openRouterKey, setOpenRouterKey] = useState(loadOpenRouterKey);
  const saveKey = (key: string) => {
    if (!saveOpenRouterKey(key)) return false;
    setOpenRouterKey(key);
    return true;
  };

  // The catalogue is only fetched once a robot actually uses OpenRouter.
  const [catalog, setCatalog] = useState<{ models: ModelOption[]; error: string | null; loading: boolean }>({ models: [], error: null, loading: false });
  const wantsCatalog = [setup.players.A, setup.players.B].some((p) => p.provider === OPENROUTER);
  const hasCatalog = catalog.models.length > 0;
  useEffect(() => {
    if (!wantsCatalog || hasCatalog) return;
    const controller = new AbortController();
    setCatalog({ models: [], error: null, loading: true });
    fetchOpenRouterModels(controller.signal)
      .then((models) => setCatalog({ models, error: null, loading: false }))
      .catch((error) => {
        if (!controller.signal.aborted) setCatalog({ models: [], error: errorMessage(error), loading: false });
      });
    return () => controller.abort();
  }, [wantsCatalog, hasCatalog]);

  const providers = useMemo(() => serverProviders && withOpenRouter(serverProviders, !!openRouterKey, catalog.models), [serverProviders, openRouterKey, catalog.models]);

  // Robots are named after their models.
  const players = useMemo(() => withModelNames(setup.players, providers), [setup.players, providers]);
  // Remember each name, so it shows correctly next time before the model lists arrive.
  useEffect(() => {
    if (players.A.name === setup.players.A.name && players.B.name === setup.players.B.name) return;
    if (!serverProviders || (wantsCatalog && !hasCatalog)) return;
    setSetup((s) => ({ ...s, players }));
  }, [players, setup.players, serverProviders, wantsCatalog, hasCatalog]);

  const issues = useMemo(() => validateSetup(setup, providers), [setup, providers]);

  // Setup preview: the real battlefield with both robots at their start tiles in the chosen colours.
  useEffect(() => {
    if (!battlefield || screen !== "setup") return;
    const board = buildBoard(getMap(setup.mapId));
    const rules = { ...DEFAULT_RULES, turnLimit: setup.turnLimit };
    battlefield.setMatch(board, rules, createInitialState(board, rules, setup.firstSide), { A: setup.players.A.color, B: setup.players.B.color }, { A: players.A.name, B: players.B.name });
    // Colours and names are applied by the next effect without rebuilding the board.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [battlefield, screen, setup.mapId]);
  useEffect(() => {
    if (!battlefield || screen !== "setup") return;
    battlefield.setColors({ A: players.A.color, B: players.B.color });
    battlefield.setNames({ A: players.A.name, B: players.B.name });
  }, [battlefield, screen, players]);

  const handleFinish = useCallback((record: MatchRecord) => {
    if (record.turns.length > 0) setHistory(saveToHistory(record));
    if (record.result?.winner) sound.fanfare();
    const s = seriesRef.current;
    if (!s || s.configs[s.index]?.id !== record.id) return;
    const updated = { ...s, records: [...s.records, record] };
    setSeries(updated);
    if (record.result?.reason !== "stopped" && s.index + 1 < s.configs.length) setNextIn(NEXT_GAME_SECONDS);
  }, []);

  const launch = useCallback(
    (config: MatchConfig) => {
      runnerRef.current?.dispose();
      setNextIn(null);
      const r = new MatchRunner(config, httpDecider, battlefield, { onFinish: handleFinish });
      runnerRef.current = r;
      battlefield?.setMatch(r.board, config.rules, r.getSnapshot().state, { A: config.players.A.color, B: config.players.B.color }, { A: config.players.A.name, B: config.players.B.name });
      setRunner(r);
      setScreen("match");
      r.start();
    },
    [battlefield, handleFinish],
  );

  const startFromSetup = () => {
    if (issues.length) return;
    sound.unlock();
    const base = toMatchConfig({ ...setup, players }, newId(), Math.floor(Math.random() * 2 ** 31));
    const seriesId = newId();
    const configs = setup.seriesGames > 1 ? planSeries(base, setup.seriesGames, seriesId, newId) : [base];
    const s: SeriesState | null = configs.length > 1 ? { id: seriesId, configs, index: 0, records: [] } : null;
    setSeries(s);
    seriesRef.current = s;
    launch(configs[0]);
  };

  const nextGame = useCallback(() => {
    const s = seriesRef.current;
    if (!s || s.index + 1 >= s.configs.length) return;
    const updated = { ...s, index: s.index + 1 };
    setSeries(updated);
    seriesRef.current = updated;
    launch(s.configs[updated.index]);
  }, [launch]);

  // Series countdown to the next game; any user action on the result card can start it sooner.
  useEffect(() => {
    if (nextIn === null) return;
    if (nextIn <= 0) {
      nextGame();
      return;
    }
    const t = window.setTimeout(() => setNextIn((n) => (n === null ? null : n - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [nextIn, nextGame]);

  const restart = () => {
    if (!runner) return;
    const config = runner.config;
    runner.stop();
    const fresh = { ...config, id: newId() };
    const s = seriesRef.current;
    if (s) {
      const configs = s.configs.map((c, i) => (i === s.index ? fresh : c));
      const updated = { ...s, configs, records: s.records.filter((r) => r.id !== config.id) };
      setSeries(updated);
      seriesRef.current = updated;
    }
    launch(fresh);
  };

  const rematch = () => {
    if (!runner) return;
    const c = runner.config;
    setSeries(null);
    seriesRef.current = null;
    launch({ ...c, id: newId(), series: undefined, firstSide: c.firstSide === "A" ? "B" : "A", seed: c.seed + 1 });
  };

  const backToSetup = () => {
    runnerRef.current?.stop();
    runnerRef.current?.dispose();
    runnerRef.current = null;
    setRunner(null);
    setSeries(null);
    seriesRef.current = null;
    setNextIn(null);
    setReplay(null);
    setScreen("setup");
    loadProviders(false);
  };

  const openReplay = (record: MatchRecord) => {
    if (runnerRef.current && !["over", "stopped"].includes(runnerRef.current.getSnapshot().phase)) runnerRef.current.stop();
    setNextIn(null);
    setDialog(null);
    setReplay(record);
    setScreen("replay");
  };

  const exitReplay = () => {
    setReplay(null);
    if (runner) {
      const snap = runner.getSnapshot();
      battlefield?.setMatch(runner.board, runner.config.rules, snap.state, { A: runner.config.players.A.color, B: runner.config.players.B.color }, { A: runner.config.players.A.name, B: runner.config.players.B.name });
      setScreen("match");
    } else setScreen("setup");
  };

  const exportRecord = (record: MatchRecord) => {
    const stamp = record.createdAt.slice(0, 19).replace(/[:T]/g, "-");
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    downloadJson(`uplink-duel_${slug(record.players.A.name)}-vs-${slug(record.players.B.name)}_${stamp}.json`, record);
  };

  const openReel = (record: MatchRecord) => {
    setReelRecord(record);
    setDialog("reel");
  };

  const swapSides = () => setSetup((s) => ({ ...s, players: { A: s.players.B, B: s.players.A } }));

  const seriesSummary = series ? { game: series.index + 1, of: series.configs.length, records: series.records } : null;

  return (
    <div className="app">
      <header className="topbar">
        <button type="button" className="brand" onClick={screen === "setup" ? undefined : backToSetup} aria-label={screen === "setup" ? "Uplink Duel" : "Back to setup"} disabled={screen === "setup"}>
          <Logo />
          <span className="brand-name">Uplink Duel</span>
          <span className="brand-tag">AI vs AI tactics</span>
        </button>
        <nav className="topbar-actions" aria-label="App">
          {screen !== "setup" && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={backToSetup}>
              <Icon name="chevronLeft" size={16} /> <span className="btn-label">Setup</span>
            </button>
          )}
          {screen === "setup" && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => loadProviders(true)} disabled={checking}>
              <Icon name="restart" size={16} /> <span className="btn-label">{checking ? "Checking…" : "Check sign-in"}</span>
            </button>
          )}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDialog("settings")}>
            <Icon name="gear" size={16} /> <span className="btn-label">Settings</span>
            {openRouterKey && (
              <span className="saved-dot">
                <span className="sr-only">OpenRouter key saved</span>
              </span>
            )}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDialog("rules")}>
            <Icon name="info" size={16} /> <span className="btn-label">Rules</span>
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDialog("history")}>
            <Icon name="history" size={16} /> <span className="btn-label">History</span>
            {history.length ? <span className="count">{history.length}</span> : null}
          </button>
          {screen === "setup" && (
            <button type="button" className="btn btn--ghost btn--icon" onClick={() => setMuted((m) => !m)} aria-label={muted ? "Unmute sound" : "Mute sound"} aria-pressed={muted}>
              <Icon name={muted ? "mute" : "volume"} />
            </button>
          )}
        </nav>
      </header>

      <main className="workspace" data-screen={screen}>
        <Stage onReady={onStageReady} />
        {webglFailed && (
          <div className="stage-layer">
            <div className="banner banner--error" role="alert">
              <Icon name="alert" />
              <div>
                <p className="banner-title">The 3D battlefield could not start</p>
                <p>This browser or device has WebGL turned off. Matches still run and the log and inspector work; enable hardware acceleration to see the battlefield.</p>
              </div>
            </div>
          </div>
        )}

        {screen === "setup" && (
          <>
            <aside className="pane pane--left">
              <RobotConfig side="A" onCheckModels={checkModels} checkingModels={checkingModels} catalog={catalog} onOpenSettings={() => setDialog("settings")} player={players.A} otherColor={setup.players.B.color} providers={providers} providersError={providersError} issues={issues} onChange={(A) => setSetup((s) => ({ ...s, players: { ...s.players, A } }))} />
            </aside>
            <div className="stage-caption" aria-hidden="true">
              <span style={{ color: players.A.color }}>{players.A.name}</span>
              <span className="vs">vs</span>
              <span style={{ color: players.B.color }}>{players.B.name}</span>
            </div>
            <aside className="pane pane--right">
              <RobotConfig side="B" onCheckModels={checkModels} checkingModels={checkingModels} catalog={catalog} onOpenSettings={() => setDialog("settings")} player={players.B} otherColor={setup.players.A.color} providers={providers} providersError={providersError} issues={issues} onChange={(B) => setSetup((s) => ({ ...s, players: { ...s.players, B } }))} />
            </aside>
            <div className="pane pane--bottom">
              {providersError && (
                <div className="banner banner--error banner--inline" role="alert">
                  <Icon name="alert" />
                  <div>
                    <p className="banner-title">{serverProviders ? "Something went wrong" : "Can't reach the game server"}</p>
                    <p>
                      {providersError}
                      {serverProviders ? "" : ". Start it with `npm run dev`, then retry."}
                    </p>
                  </div>
                  <button type="button" className="btn btn--secondary btn--sm" onClick={() => loadProviders(true)}>
                    Retry
                  </button>
                </div>
              )}
              <MatchSettings setup={setup} issues={issues} onChange={(patch) => setSetup((s) => ({ ...s, ...patch }))} onSwap={swapSides} onStart={startFromSetup} />
            </div>
          </>
        )}

        {screen === "match" && runner && (
          <MatchView
            key={runner.config.id}
            runner={runner}
            battlefield={battlefield}
            providers={providers ?? []}
            series={seriesSummary}
            nextIn={nextIn}
            muted={muted}
            onToggleMute={() => {
              sound.unlock();
              setMuted((m) => !m);
            }}
            onNext={series && series.index + 1 < series.configs.length && series.records.length > series.index ? nextGame : undefined}
            onRestart={restart}
            onRematch={rematch}
            onReplay={openReplay}
            onExport={exportRecord}
            onReel={openReel}
            onSetup={backToSetup}
          />
        )}

        {screen === "replay" && replay && <ReplayView key={replay.id} record={replay} battlefield={battlefield} providers={providers ?? []} onExit={exitReplay} onExport={() => exportRecord(replay)} onReel={() => openReel(replay)} />}
      </main>

      <Dialog open={dialog === "reel"} title="Download reel" onClose={() => setDialog(null)}>
        {reelRecord && <ReelPanel key={reelRecord.id} record={reelRecord} providers={providers ?? []} />}
      </Dialog>
      <Dialog open={dialog === "settings"} title="Settings" onClose={() => setDialog(null)}>
        <SettingsPanel openRouterKey={openRouterKey} onSaveKey={saveKey} onClose={() => setDialog(null)} />
      </Dialog>
      <Dialog open={dialog === "rules"} title="How Uplink Duel works" onClose={() => setDialog(null)}>
        <RulesPanel />
      </Dialog>
      <Dialog open={dialog === "history"} title="Match history" onClose={() => setDialog(null)} wide>
        <HistoryPanel
          history={history}
          onReplay={openReplay}
          onExport={exportRecord}
          onReel={openReel}
          onDelete={(id) => setHistory(removeFromHistory(id))}
          onImport={(record) => {
            setHistory(saveToHistory(record));
            openReplay(record);
          }}
        />
      </Dialog>
    </div>
  );
}
