import type { CityData } from "../../../ingest/types.js";
import type { Replay } from "./replay.js";

const DAY = 86_400;
/** trailing window for the rate readouts */
const WINDOW_DAYS = 90;

export interface CityMetrics {
  /** occupied grid cells ÷ total grid cells across every district */
  density: number;
  /** share of the codebase rewritten per day, as a percentage */
  churnPctPerDay: number;
  /** net lines added per day */
  growthLocPerDay: number;
  /** buildings standing in the frame being shown */
  buildings: number;
  districts: number;
  /** lines per standing building */
  avgHeight: number;
}

/** Every number here describes the frame currently on screen, not the repo's lifetime. */
export function computeMetrics(data: CityData, replay: Replay, frameIndex: number): CityMetrics {
  let cells = 0;
  for (const d of data.districts) cells += d.cells;

  let standing = 0;
  let lines = 0;
  for (let i = 0; i < replay.lines.length; i++) {
    const h = replay.lines[i];
    if (h > 0) {
      standing++;
      lines += h;
    }
  }

  const frames = data.frames;
  const at = Math.min(frames.length - 1, Math.max(0, frameIndex));
  const now = frames[at];

  let start = at;
  while (start > 0 && now.ts - frames[start - 1].ts < WINDOW_DAYS * DAY) start--;
  const spanDays = Math.max(1, (now.ts - frames[start].ts) / DAY);

  let churnWindow = 0;
  for (let i = start + 1; i <= at; i++) churnWindow += replay.churnPerFrame[i];

  return {
    density: cells > 0 ? standing / cells : 0,
    churnPctPerDay: lines > 0 ? (churnWindow / spanDays / lines) * 100 : 0,
    growthLocPerDay: (now.lines - frames[start].lines) / spanDays,
    buildings: standing,
    districts: data.districts.length,
    avgHeight: standing > 0 ? lines / standing : 0,
  };
}
