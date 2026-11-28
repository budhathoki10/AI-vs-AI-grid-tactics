import { AudioBufferSource, BufferTarget, canEncodeAudio, canEncodeVideo, CanvasSource, Mp4OutputFormat, Output, Quality } from "mediabunny";
import { buildBoard, getMap } from "../../engine/maps";
import type { MatchRecord, TurnRecord } from "../../engine/record";
import type { GameState, Side } from "../../engine/types";
import { createSynthTarget, playCue, type SynthTarget } from "../lib/sound";
import { Battlefield, type SoundName } from "../scene/Battlefield";
import { BOARD, drawFrame, loadReelFonts, type Frame } from "./drawFrame";
import { FPS, INTRO_SECONDS, OUTRO_SECONDS, PACES, REEL_HEIGHT, REEL_WIDTH, type Pace } from "./reel";

export interface ReelOptions {
  pace: Pace;
  sound: boolean;
  /** "Provider · Model" for each side. */
  models: Record<Side, string>;
  signal: AbortSignal;
  /** 0 to 1. */
  onProgress: (done: number) => void;
}

export interface Reel {
  blob: Blob;
  seconds: number;
  /** False when sound was asked for but this browser cannot encode it. */
  hasSound: boolean;
}

const SAMPLE_RATE = 48_000;
const VIDEO_QUALITY = new Quality("high");

interface Cue {
  name: SoundName | "fanfare";
  at: number;
}

async function renderSound(cues: Cue[], seconds: number): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  const target: SynthTarget = createSynthTarget(ctx);
  for (const cue of cues) playCue(target, cue.name, cue.at);
  return ctx.startRendering();
}

/**
 * Replays a stored match on a hidden battlefield, frame by frame on a manual clock, and encodes it as a
 * 9:16 MP4 in the browser. Nothing is uploaded, and model thinking time is left out.
 */
export async function exportReel(record: MatchRecord, options: ReelOptions): Promise<Reel> {
  if (typeof VideoEncoder === "undefined" || !(await canEncodeVideo("avc", { width: REEL_WIDTH, height: REEL_HEIGHT, quality: VIDEO_QUALITY })))
    throw new Error("This browser cannot make MP4 video. Open the app in a current Chrome or Edge and try again.");
  const hasSound = options.sound && (await canEncodeAudio("aac", { numberOfChannels: 2, sampleRate: SAMPLE_RATE }));
  await loadReelFonts();

  const canvas = document.createElement("canvas");
  canvas.width = REEL_WIDTH;
  canvas.height = REEL_HEIGHT;
  const ctx = canvas.getContext("2d")!;
  const cues: Cue[] = [];
  let frames = 0;
  const scene = new Battlefield(document.createElement("div"), {
    offline: { width: BOARD.width, height: BOARD.height },
    onSound: (name) => cues.push({ name, at: frames / FPS }),
  });

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const video = new CanvasSource(canvas, { codec: "avc", quality: VIDEO_QUALITY });
  output.addVideoTrack(video, { frameRate: FPS });
  const audio = hasSound ? new AudioBufferSource({ codec: "aac", quality: VIDEO_QUALITY }) : null;
  if (audio) output.addAudioTrack(audio);

  try {
    await output.start();
    const { players, rules, initialState } = record;
    scene.setMatch(buildBoard(getMap(record.mapId), record.swapStarts), rules, initialState, { A: players.A.color, B: players.B.color }, { A: players.A.name, B: players.B.name });

    let state: GameState = initialState;
    let turn: TurnRecord | null = null;
    let card: Frame["card"] = "intro";
    const frame = async () => {
      options.signal.throwIfAborted();
      const image = scene.advance(1000 / FPS);
      drawFrame(ctx, { record, models: options.models, scene: image, overlay: scene.overlay(), state, turn, card });
      await video.add(frames / FPS, 1 / FPS);
      frames++;
    };
    const hold = async (seconds: number) => {
      for (let i = Math.round(seconds * FPS); i > 0; i--) await frame();
    };

    await hold(INTRO_SECONDS);
    card = null;
    const { lead, read } = PACES[options.pace];
    for (const [index, next] of record.turns.entries()) {
      turn = next;
      state = next.stateBefore;
      scene.sync(state);
      scene.showThinking(next.side, state);
      await hold(lead);
      let playing = true;
      const animation = scene.present(next).then(() => (playing = false));
      while (playing) await frame();
      await animation;
      state = next.stateAfter;
      await hold(read);
      options.onProgress(((index + 1) / record.turns.length) * 0.97);
    }
    card = "outro";
    if (record.result?.winner) cues.push({ name: "fanfare", at: frames / FPS });
    await hold(OUTRO_SECONDS);

    const seconds = frames / FPS;
    if (audio) await audio.add(await renderSound(cues, seconds));
    await output.finalize();
    options.onProgress(1);
    return { blob: new Blob([output.target.buffer!], { type: "video/mp4" }), seconds, hasSound };
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  } finally {
    scene.dispose();
  }
}
