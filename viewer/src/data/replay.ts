import type { CityData } from "../../../ingest/types.js";

/** Full snapshots every N frames so scrubbing never replays from zero. */
const KEYFRAME_EVERY = 16;

export interface Replay {
  frames: number;
  buildings: number;
  /** line count per building at the sought frame */
  lines: Int32Array;
  /** unix seconds when each building was last touched, at the sought frame */
  touch: Uint32Array;
  /** buildings standing at the sought frame */
  standing: number;
  /**
   * Building indices whose height changed on the last `seek`, or `null` when
   * the jump was large enough that everything has to be reconsidered. Stepping
   * one frame at a time — which is what playback does — touches a few hundred
   * buildings out of twenty thousand.
   */
  changed: Int32Array | null;
  seek(frame: number): void;
  /** |Δlines| summed per frame — the churn readout and the timeline bars */
  churnPerFrame: Float64Array;
}

export function createReplay(data: CityData): Replay {
  const n = data.buildings.length;
  const frameCount = data.frames.length;

  const lines = new Int32Array(n);
  const touch = new Uint32Array(n);
  const churnPerFrame = new Float64Array(frameCount);

  const keyAt: number[] = [];
  const keyLines: Int32Array[] = [];
  const keyTouch: Uint32Array[] = [];

  // one forward pass builds every keyframe and the churn series at once
  {
    const l = new Int32Array(n);
    const t = new Uint32Array(n);
    for (let f = 0; f < frameCount; f++) {
      const frame = data.frames[f];
      let churn = 0;
      for (let i = 0; i < frame.delta.length; i += 2) {
        const idx = frame.delta[i];
        const h = frame.delta[i + 1];
        churn += Math.abs(h - l[idx]);
        l[idx] = h;
        t[idx] = frame.ts;
      }
      churnPerFrame[f] = churn;
      if (f % KEYFRAME_EVERY === 0) {
        keyAt.push(f);
        keyLines.push(l.slice());
        keyTouch.push(t.slice());
      }
    }
  }

  let standing = 0;
  let at = -1;

  const seek = (frame: number): void => {
    const target = Math.min(frameCount - 1, Math.max(0, Math.round(frame)));

    // one step forward: apply that frame's delta in place and report exactly
    // what moved, so the renderer can skip twenty thousand untouched buildings
    if (target === at + 1 && at >= 0) {
      const d = data.frames[target];
      const touched = new Int32Array(d.delta.length / 2);
      for (let i = 0, j = 0; i < d.delta.length; i += 2, j++) {
        const idx = d.delta[i];
        const next = d.delta[i + 1];
        if (lines[idx] > 0 && next <= 0) standing--;
        else if (lines[idx] <= 0 && next > 0) standing++;
        lines[idx] = next;
        touch[idx] = d.ts;
        touched[j] = idx;
      }
      at = target;
      replay.changed = touched;
      replay.standing = standing;
      return;
    }

    let k = keyAt.length - 1;
    while (k > 0 && keyAt[k] > target) k--;

    lines.set(keyLines[k]);
    touch.set(keyTouch[k]);

    for (let f = keyAt[k] + 1; f <= target; f++) {
      const d = data.frames[f];
      for (let i = 0; i < d.delta.length; i += 2) {
        lines[d.delta[i]] = d.delta[i + 1];
        touch[d.delta[i]] = d.ts;
      }
    }

    let count = 0;
    for (let i = 0; i < n; i++) if (lines[i] > 0) count++;
    standing = count;
    at = target;
    replay.changed = null;
    replay.standing = count;
  };

  const replay: Replay = {
    frames: frameCount,
    buildings: n,
    lines,
    touch,
    standing,
    changed: null,
    seek,
    churnPerFrame,
  };

  seek(frameCount - 1);
  return replay;
}
