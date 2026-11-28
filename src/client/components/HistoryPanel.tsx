import { useMemo, useRef, useState } from "react";
import { getMap } from "../../engine/maps";
import { upgradeRecord, verifyReplay, type MatchRecord } from "../../engine/record";
import { formatMs, named } from "../lib/format";
import { Icon } from "./Icon";

interface Props {
  history: MatchRecord[];
  onReplay: (record: MatchRecord) => void;
  onExport: (record: MatchRecord) => void;
  onReel: (record: MatchRecord) => void;
  onDelete: (id: string) => void;
  onImport: (record: MatchRecord) => void;
}

interface HeadToHead {
  key: string;
  a: string;
  b: string;
  winsA: number;
  winsB: number;
  draws: number;
  games: number;
}

/** Model-vs-model tallies across saved matches, keyed by provider/model rather than by side. */
function headToHead(history: MatchRecord[]): HeadToHead[] {
  const map = new Map<string, HeadToHead>();
  for (const r of history) {
    if (!r.result || r.result.reason === "stopped") continue;
    const ids = (["A", "B"] as const).map((s) => ({ side: s, id: `${r.players[s].provider}/${r.players[s].model}`, name: r.players[s].name }));
    ids.sort((x, y) => x.id.localeCompare(y.id));
    const [first, second] = ids;
    const key = `${first.id} vs ${second.id}`;
    const row = map.get(key) ?? { key, a: first.id, b: second.id, winsA: 0, winsB: 0, draws: 0, games: 0 };
    row.games++;
    if (!r.result.winner) row.draws++;
    else if (r.result.winner === first.side) row.winsA++;
    else row.winsB++;
    map.set(key, row);
  }
  return [...map.values()].sort((x, y) => y.games - x.games);
}

export function HistoryPanel({ history, onReplay, onExport, onReel, onDelete, onImport }: Props) {
  const file = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const rows = useMemo(() => headToHead(history), [history]);

  const importFile = async (f: File) => {
    setImportError(null);
    try {
      const record = upgradeRecord(JSON.parse(await f.text()));
      const check = verifyReplay(record);
      if (!check.ok) throw new Error(`The record does not replay cleanly (diverges at turn ${check.divergedAt}).`);
      onImport(record);
    } catch (error) {
      setImportError((error as Error).message);
    }
  };

  return (
    <div className="history">
      <div className="history-toolbar">
        <p className="muted">{history.length ? `${history.length} saved match${history.length === 1 ? "" : "es"}, stored in this browser.` : "Finished matches are saved here automatically."}</p>
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = "";
          }}
        />
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => file.current?.click()}>
          <Icon name="upload" size={16} /> Import match
        </button>
      </div>
      {importError && (
        <p className="field-error" role="alert">
          {importError}
        </p>
      )}

      {rows.length > 0 && (
        <section className="h2h" aria-labelledby="h2h-title">
          <h3 id="h2h-title">Head to head</h3>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Pairing</th>
                <th scope="col">Games</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    {r.a} <span className="muted">vs</span> {r.b}
                  </td>
                  <td className="tabular">{r.games}</td>
                  <td className="tabular">
                    {r.winsA}–{r.winsB}
                    {r.draws ? ` · ${r.draws}D` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="fine">Performance in Uplink Duel's rules and maps only. Run series (which alternate first move and start tiles) before drawing conclusions.</p>
        </section>
      )}

      {history.length === 0 ? (
        <div className="empty">
          <Icon name="history" size={28} />
          <p>No matches yet</p>
          <p className="muted">Start a match with the built-in mock models to see how replays work.</p>
        </div>
      ) : (
        <ul className="history-list">
          {history.map((r) => {
            const winner = r.result?.winner;
            return (
              <li key={r.id} className="history-item">
                <div className="history-main">
                  <p className="history-players">
                    <span style={{ color: r.players.A.color }}>●</span> {r.players.A.name} <span className="muted">vs</span> <span style={{ color: r.players.B.color }}>●</span> {r.players.B.name}
                  </p>
                  <p className="muted">
                    {new Date(r.createdAt).toLocaleString()} · {getMap(r.mapId).name} · {r.turns.length} actions · {formatMs(r.durationMs)}
                    {r.series ? ` · series game ${r.series.game}/${r.series.of}` : ""}
                  </p>
                  <p className="history-result">
                    {r.result?.reason === "stopped" ? "Stopped" : winner ? <b style={{ color: r.players[winner].color }}>{r.players[winner].name} won</b> : "Draw"}
                    <span className="muted"> — {r.result ? named(r.result.detail, r.players) : ""}</span>
                  </p>
                </div>
                <div className="history-actions">
                  <button type="button" className="btn btn--secondary btn--sm" onClick={() => onReplay(r)} disabled={r.turns.length === 0}>
                    <Icon name="eye" size={16} /> Replay
                  </button>
                  <button type="button" className="btn btn--ghost btn--icon" onClick={() => onReel(r)} disabled={r.turns.length === 0} aria-label="Download reel video" title="Download reel video">
                    <Icon name="video" size={16} />
                  </button>
                  <button type="button" className="btn btn--ghost btn--icon" onClick={() => onExport(r)} aria-label="Export match JSON">
                    <Icon name="download" size={16} />
                  </button>
                  <button type="button" className="btn btn--ghost btn--icon btn--danger" onClick={() => onDelete(r.id)} aria-label="Delete match">
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
