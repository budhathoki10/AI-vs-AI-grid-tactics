import { useEffect, useRef, useState } from "react";
import type { ProviderInfo } from "../../ai/protocol";
import type { MatchRecord } from "../../engine/record";
import { modelLabel } from "../lib/format";
import { estimateSeconds, PACES, reelFileName, type Pace } from "../video/reel";
import { Icon } from "./Icon";
import { Segmented } from "./Segmented";

type Job = { kind: "idle" } | { kind: "working"; done: number } | { kind: "ready"; url: string; seconds: number; megabytes: number; silent: boolean } | { kind: "error"; message: string };

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

/** Makes an Instagram-reel video of a stored match. Closing the dialog cancels a render in progress. */
export function ReelPanel({ record, providers }: { record: MatchRecord; providers: ProviderInfo[] }) {
  const [pace, setPace] = useState<Pace>("normal");
  const [withSound, setWithSound] = useState(true);
  const [job, setJob] = useState<Job>({ kind: "idle" });
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);
  const url = job.kind === "ready" ? job.url : null;
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  const create = async () => {
    const abort = new AbortController();
    controller.current = abort;
    setJob({ kind: "working", done: 0 });
    try {
      // Loaded on demand: the encoder is only needed by people who make a video.
      const { exportReel } = await import("../video/exportReel");
      const reel = await exportReel(record, {
        pace,
        sound: withSound,
        models: { A: modelLabel(record.players.A, providers), B: modelLabel(record.players.B, providers) },
        signal: abort.signal,
        onProgress: (done) => !abort.signal.aborted && setJob({ kind: "working", done }),
      });
      if (abort.signal.aborted) return;
      setJob({ kind: "ready", url: URL.createObjectURL(reel.blob), seconds: reel.seconds, megabytes: reel.blob.size / 1e6, silent: withSound && !reel.hasSound });
    } catch (error) {
      if (abort.signal.aborted) return setJob({ kind: "idle" });
      console.error("Reel export failed", error);
      setJob({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  if (job.kind === "ready")
    return (
      <div className="reel">
        <video className="reel-preview" src={job.url} controls playsInline preload="auto" aria-label="Reel preview" />
        <p className="fine" role="status">
          MP4, 1080×1920, {clock(job.seconds)}, {job.megabytes.toFixed(1)} MB.
          {job.silent ? " This browser could not encode sound, so the video is silent." : ""} Upload it to Instagram as a reel.
        </p>
        <div className="reel-actions">
          <button type="button" className="btn btn--ghost" onClick={() => setJob({ kind: "idle" })}>
            Change options
          </button>
          <a className="btn btn--primary" href={job.url} download={reelFileName(record)}>
            <Icon name="download" /> Download video
          </a>
        </div>
      </div>
    );

  const working = job.kind === "working";
  return (
    <div className="reel">
      <p>
        A vertical video of this match for Instagram: both models, every action with the model&apos;s own explanation, and the result. It is made in your browser; nothing is uploaded.
      </p>
      {working ? (
        <div className="reel-progress" role="status">
          <label htmlFor="reel-progress">Making the video… {Math.round(job.done * 100)}%</label>
          <progress id="reel-progress" max={1} value={job.done} />
          <p className="fine">Keep this window open. A long match can take a few minutes.</p>
        </div>
      ) : (
        <>
          <div className="field">
            <Segmented label="Pace" value={pace} options={(Object.keys(PACES) as Pace[]).map((p) => ({ value: p, label: PACES[p].label }))} onChange={setPace} />
            <p className="field-hint">
              {record.turns.length} actions, about {clock(estimateSeconds(record, pace))} long. Thinking time is left out.
            </p>
          </div>
          <label className="reel-check">
            <input type="checkbox" checked={withSound} onChange={(e) => setWithSound(e.target.checked)} />
            Include sound effects
          </label>
        </>
      )}
      {job.kind === "error" && (
        <p className="field-error" role="alert">
          {job.message}
        </p>
      )}
      <div className="reel-actions">
        {working ? (
          <button type="button" className="btn btn--secondary" onClick={() => controller.current?.abort()}>
            Cancel
          </button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={() => void create()}>
            <Icon name="video" /> {job.kind === "error" ? "Try again" : "Create video"}
          </button>
        )}
      </div>
    </div>
  );
}
