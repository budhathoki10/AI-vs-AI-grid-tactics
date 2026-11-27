/** A tiny frame-driven animation scheduler: no per-frame allocations, cancellable, promise-based. */

export type Ease = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
} satisfies Record<string, Ease>;

interface Task {
  start: number;
  duration: number;
  update: (t: number) => void;
  ease: Ease;
  resolve: () => void;
}

export class Animator {
  private tasks: Task[] = [];
  private time = 0;
  /** Multiplies every duration; reduced-motion users get shorter animations. */
  speed = 1;

  get busy(): boolean {
    return this.tasks.length > 0;
  }

  tick(now: number): void {
    this.time = now;
    if (!this.tasks.length) return;
    const remaining: Task[] = [];
    for (const task of this.tasks) {
      const raw = task.duration <= 0 ? 1 : (now - task.start) / task.duration;
      const t = raw >= 1 ? 1 : raw < 0 ? 0 : raw;
      task.update(task.ease(t));
      if (t >= 1) task.resolve();
      else remaining.push(task);
    }
    this.tasks = remaining;
  }

  /** Animate `update(0→1)` over `ms`. Resolves when finished (or immediately when interrupted). */
  run(ms: number, update: (t: number) => void, easing: Ease = ease.inOutCubic): Promise<void> {
    return new Promise((resolve) => {
      this.tasks.push({ start: this.time, duration: ms * this.speed, update, ease: easing, resolve });
    });
  }

  wait(ms: number): Promise<void> {
    return this.run(ms, () => {}, ease.linear);
  }

  /** Jump every running animation to its end state. */
  finishAll(): void {
    const tasks = this.tasks;
    this.tasks = [];
    for (const task of tasks) {
      task.update(task.ease(1));
      task.resolve();
    }
  }
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Shortest-path angle interpolation. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
