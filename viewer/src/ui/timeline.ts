import type { CityData } from "../../../ingest/types.js";
import { rampCss } from "../scene/materials.js";
import { compact, n, year } from "../util/format.js";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export const SPEEDS = [0.5, 1, 2, 4] as const;

export interface TimelineCallbacks {
  onSeek(frame: number, live: boolean): void;
  onTogglePlay(): void;
  onStep(delta: number): void;
  onSpeed(speed: number): void;
  onFlythrough(): void;
}

export interface TimelineHandle {
  mount(data: CityData): void;
  setFrame(index: number): void;
  setPlaying(playing: boolean): void;
  setSpeed(speed: number): void;
  setFlythrough(active: boolean): void;
}

export function createTimeline(cb: TimelineCallbacks): TimelineHandle {
  const plot = el("tl-plot");
  const bars = el("tl-bars");
  const mask = el("tl-mask");
  const head = el("tl-head");
  const axis = el("tl-axis");
  const frameLabel = el("tl-frame");
  const playBtn = el<HTMLButtonElement>("tl-play");
  const speedBtn = el<HTMLButtonElement>("tl-speed");
  const flyBtn = el<HTMLButtonElement>("tl-fly");
  const chip = el("tl-chip");

  let data: CityData | null = null;
  let count = 0;
  let scrubbing = false;
  let axisKeyOf: (ts: number) => string = (ts) => String(year(ts));

  const frameFromClientX = (clientX: number): number => {
    const rect = plot.getBoundingClientRect();
    const pct = (clientX - rect.left) / Math.max(1, rect.width);
    return Math.min(count - 1, Math.max(0, Math.round(pct * count - 0.5)));
  };

  plot.addEventListener("pointerdown", (e) => {
    if (count === 0) return;
    scrubbing = true;
    plot.setPointerCapture(e.pointerId);
    plot.classList.add("is-scrubbing");
    cb.onSeek(frameFromClientX(e.clientX), true);
  });

  plot.addEventListener("pointermove", (e) => {
    if (!scrubbing) return;
    cb.onSeek(frameFromClientX(e.clientX), true);
  });

  const endScrub = (e: PointerEvent) => {
    if (!scrubbing) return;
    scrubbing = false;
    plot.releasePointerCapture?.(e.pointerId);
    plot.classList.remove("is-scrubbing");
    cb.onSeek(frameFromClientX(e.clientX), false);
  };
  plot.addEventListener("pointerup", endScrub);
  plot.addEventListener("pointercancel", endScrub);

  playBtn.addEventListener("click", () => cb.onTogglePlay());
  el("tl-prev").addEventListener("click", () => cb.onStep(-1));
  el("tl-next").addEventListener("click", () => cb.onStep(1));
  flyBtn.addEventListener("click", () => cb.onFlythrough());

  speedBtn.addEventListener("click", () => {
    const current = Number(speedBtn.dataset.speed ?? "1");
    const index = SPEEDS.indexOf(current as (typeof SPEEDS)[number]);
    cb.onSpeed(SPEEDS[(index + 1) % SPEEDS.length]);
  });

  return {
    mount(next) {
      data = next;
      count = next.frames.length;
      if (count === 0) return;

      // bars: real commit volume per bucket, coloured by position in history
      bars.textContent = "";
      const peak = Math.max(1, ...next.frames.map((f) => f.commits));
      const fragment = document.createDocumentFragment();
      next.frames.forEach((f, i) => {
        const bar = document.createElement("i");
        bar.style.height = `${Math.max(2, Math.pow(f.commits / peak, 0.55) * 100)}%`;
        bar.style.background = rampCss(count > 1 ? i / (count - 1) : 1);
        fragment.append(bar);
      });
      bars.append(fragment);

      // A repository eighteen months old gets months on the axis; anything
      // longer gets years, or the whole scale collapses to a single label.
      const span = next.frames[count - 1].ts - next.frames[0].ts;
      const byMonth = span < 550 * 86400;

      axis.textContent = "";
      let previous = "";
      next.frames.forEach((f, i) => {
        const date = new Date(f.ts * 1000);
        const key = byMonth
          ? `${date.getUTCFullYear()}-${date.getUTCMonth()}`
          : String(year(f.ts));
        if (key === previous) return;
        previous = key;

        const label = document.createElement("span");
        label.textContent = byMonth
          ? date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase()
          : String(year(f.ts));
        label.dataset.key = key;
        label.style.left = `${(((i + 0.5) / count) * 100).toFixed(3)}%`;
        axis.append(label);
      });
      axisKeyOf = (ts: number) => {
        const date = new Date(ts * 1000);
        return byMonth ? `${date.getUTCFullYear()}-${date.getUTCMonth()}` : String(year(ts));
      };

      // Buckets are even but commits are not, so quiet years bunch up at one
      // end. Drop labels that would collide rather than overprint them.
      requestAnimationFrame(() => {
        let lastRight = -Infinity;
        for (const node of Array.from(axis.children) as HTMLElement[]) {
          node.hidden = false;
          const left = node.offsetLeft - node.offsetWidth / 2;
          if (left - lastRight < 14) node.hidden = true;
          else lastRight = left + node.offsetWidth;
        }
      });
    },

    setFrame(index) {
      if (!data || count === 0) return;
      const i = Math.min(count - 1, Math.max(0, index));
      const pct = ((i + 0.5) / count) * 100;

      head.style.left = `clamp(8px, ${pct.toFixed(3)}%, calc(100% - 8px))`;
      mask.style.left = `${pct.toFixed(3)}%`;

      frameLabel.textContent = `FRAME ${n(i + 1)} / ${n(count)}`;
      frameLabel.style.left = `calc(5px + ${pct.toFixed(3)}% - ${((pct / 100) * 10).toFixed(2)}px)`;
      frameLabel.style.transform =
        pct > 86 ? "translateX(-100%)" : pct < 9 ? "translateX(0)" : "translateX(-50%)";

      const frame = data.frames[i];
      el("c-date").textContent = frame.date;
      el("c-commit").textContent = frame.hash;
      el("c-buildings").textContent = n(frame.buildings);
      el("c-loc").textContent = compact(frame.lines);

      const active = axisKeyOf(frame.ts);
      for (const node of axis.children) {
        (node as HTMLElement).classList.toggle("on", (node as HTMLElement).dataset.key === active);
      }
    },

    setPlaying(playing) {
      playBtn.classList.toggle("is-playing", playing);
      playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
      chip.textContent = playing ? "PLAYING" : "READY";
    },

    setSpeed(speed) {
      speedBtn.dataset.speed = String(speed);
      speedBtn.textContent = `${speed}x`;
    },

    setFlythrough(active) {
      flyBtn.classList.toggle("is-on", active);
    },
  };
}
