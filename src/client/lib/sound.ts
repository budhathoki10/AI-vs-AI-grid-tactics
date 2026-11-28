import type { SoundName } from "../scene/Battlefield";

/**
 * Small synthesized cues (no audio files). Created lazily on the first user gesture,
 * as browsers require, and silent until then.
 */
/** Where a cue is synthesized: live speakers, or an offline buffer for a video. */
export interface SynthTarget {
  ctx: BaseAudioContext;
  out: AudioNode;
  noise: AudioBuffer;
}

export const MASTER_GAIN = 0.32;

export function createSynthTarget(ctx: BaseAudioContext): SynthTarget {
  const out = ctx.createGain();
  out.gain.value = MASTER_GAIN;
  out.connect(ctx.destination);
  const length = Math.ceil(ctx.sampleRate * 0.4);
  const noise = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return { ctx, out, noise };
}

function tone({ ctx, out }: SynthTarget, t: number, freq: number, duration: number, type: OscillatorType, gain: number, slideTo?: number): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + duration);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

function burst({ ctx, out, noise }: SynthTarget, t: number, duration: number, gain: number, freq: number, q = 1): void {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  src.connect(filter).connect(g).connect(out);
  src.start(t);
  src.stop(t + duration);
}

/** Schedules one cue at time `t` (seconds) on the target. */
export function playCue(s: SynthTarget, name: SoundName | "fanfare", t: number): void {
  switch (name) {
    case "step":
      burst(s, t, 0.07, 0.35, 180, 2);
      break;
    case "fire":
      tone(s, t, 880, 0.16, "sawtooth", 0.12, 180);
      burst(s, t, 0.12, 0.25, 2400, 0.8);
      break;
    case "hit":
      tone(s, t, 140, 0.22, "sine", 0.5, 60);
      burst(s, t, 0.18, 0.3, 900, 0.7);
      break;
    case "shield":
      tone(s, t, 320, 0.35, "sine", 0.18, 640);
      break;
    case "overwatch":
      tone(s, t, 660, 0.09, "square", 0.05);
      tone(s, t + 0.1, 990, 0.09, "square", 0.05);
      break;
    case "capture":
      tone(s, t, 523, 0.18, "triangle", 0.22);
      tone(s, t + 0.12, 784, 0.3, "triangle", 0.2);
      break;
    case "score":
      tone(s, t, 1046, 0.08, "sine", 0.06);
      break;
    case "disabled":
      tone(s, t, 220, 0.9, "sawtooth", 0.12, 40);
      burst(s, t, 0.6, 0.25, 300, 0.5);
      break;
    case "fanfare":
      [523, 659, 784, 1046].forEach((f, i) => tone(s, t + i * 0.09, f, 0.5, "triangle", 0.14));
      break;
  }
}

class SoundBoard {
  private target: SynthTarget | null = null;
  private ctx: AudioContext | null = null;
  muted = false;

  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.target = createSynthTarget(this.ctx);
  }

  play(name: SoundName | "fanfare"): void {
    if (this.muted || !this.target || this.ctx?.state !== "running") return;
    playCue(this.target, name, this.ctx.currentTime);
  }

  fanfare(): void {
    this.play("fanfare");
  }
}

export const sound = new SoundBoard();
