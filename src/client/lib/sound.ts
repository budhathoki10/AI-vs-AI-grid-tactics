import type { SoundName } from "../scene/Battlefield";

/**
 * Small synthesized cues (no audio files). Created lazily on the first user gesture,
 * as browsers require, and silent until then.
 */
class SoundBoard {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  muted = false;

  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.32;
    this.master.connect(this.ctx.destination);
    const length = this.ctx.sampleRate * 0.4;
    this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  }

  private tone(freq: number, duration: number, type: OscillatorType, gain: number, slideTo?: number, delay = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + duration);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  private burst(duration: number, gain: number, freq: number, q = 1): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter).connect(g).connect(this.master!);
    src.start(t);
    src.stop(t + duration);
  }

  play(name: SoundName): void {
    if (this.muted || !this.ctx || this.ctx.state !== "running") return;
    switch (name) {
      case "step":
        this.burst(0.07, 0.35, 180, 2);
        break;
      case "fire":
        this.tone(880, 0.16, "sawtooth", 0.12, 180);
        this.burst(0.12, 0.25, 2400, 0.8);
        break;
      case "hit":
        this.tone(140, 0.22, "sine", 0.5, 60);
        this.burst(0.18, 0.3, 900, 0.7);
        break;
      case "shield":
        this.tone(320, 0.35, "sine", 0.18, 640);
        break;
      case "overwatch":
        this.tone(660, 0.09, "square", 0.05);
        this.tone(990, 0.09, "square", 0.05, undefined, 0.1);
        break;
      case "capture":
        this.tone(523, 0.18, "triangle", 0.22);
        this.tone(784, 0.3, "triangle", 0.2, undefined, 0.12);
        break;
      case "score":
        this.tone(1046, 0.08, "sine", 0.06);
        break;
      case "disabled":
        this.tone(220, 0.9, "sawtooth", 0.12, 40);
        this.burst(0.6, 0.25, 300, 0.5);
        break;
    }
  }

  fanfare(): void {
    if (this.muted || !this.ctx || this.ctx.state !== "running") return;
    [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.5, "triangle", 0.14, undefined, i * 0.09));
  }
}

export const sound = new SoundBoard();
