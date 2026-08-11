import type { Commit, Frame } from "./types.js";
import type { PathStat } from "./build-layout.js";

const DAY = 86_400;

/** Bucket sizes tried in order — the finest one that fits under the frame cap wins. */
const DAY_STEPS = [1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90, 120, 180, 365, 730];

export interface StatsResult {
  stats: Map<string, PathStat>;
  firstTs: number;
  lastTs: number;
  finalFiles: number;
  finalLines: number;
}

/**
 * First pass: replay every commit to learn each path's peak and final line
 * count. The layout needs this before frames can be built, because building
 * positions must be fixed for the whole timeline — a file that only exists in
 * 2014 still owns its plot in 2025, it is just zero-height.
 */
export function accumulateStats(commits: Commit[]): StatsResult {
  const lines = new Map<string, number>();
  const stats = new Map<string, PathStat>();

  for (const c of commits) {
    for (const f of c.files) {
      const prev = lines.get(f.path) ?? 0;
      // A binary blob has no line count; give it a token height so it still
      // reads as a building rather than vanishing.
      const next = f.binary
        ? Math.max(prev, 1)
        : Math.max(0, prev + f.added - f.removed);
      lines.set(f.path, next);

      let s = stats.get(f.path);
      if (!s) {
        s = { peak: 0, final: 0 };
        stats.set(f.path, s);
      }
      if (next > s.peak) s.peak = next;
    }
  }

  let finalFiles = 0;
  let finalLines = 0;
  for (const [path, n] of lines) {
    const s = stats.get(path)!;
    s.final = n;
    if (n > 0) {
      finalFiles++;
      finalLines += n;
    }
  }

  return {
    stats,
    firstTs: commits.length ? commits[0].ts : 0,
    lastTs: commits.length ? commits[commits.length - 1].ts : 0,
    finalFiles,
    finalLines,
  };
}

export interface BucketChoice {
  /** `commit`, `1d`, `21d`, or `chunk` */
  label: string;
  kind: "commit" | "days" | "chunk";
  days: number;
}

export function chooseBucket(commits: Commit[], maxFrames: number): BucketChoice {
  if (commits.length <= maxFrames) return { label: "commit", kind: "commit", days: 0 };

  const seen = new Set<number>();
  for (const step of DAY_STEPS) {
    seen.clear();
    const size = DAY * step;
    for (const c of commits) {
      seen.add(Math.floor(c.ts / size));
      if (seen.size > maxFrames) break;
    }
    if (seen.size <= maxFrames) {
      return { label: `${step}d`, kind: "days", days: step };
    }
  }
  return { label: "chunk", kind: "chunk", days: 0 };
}

export interface BucketOptions {
  maxFrames: number;
  pathToBuilding: Map<string, number>;
  buildingCount: number;
}

export interface BucketResult {
  frames: Frame[];
  bucket: BucketChoice;
  final: { h: number[]; t: number[] };
}

function ymd(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/**
 * Second pass: replay the commits again, snapshotting the city at every bucket
 * boundary. Frames carry only what changed — a full 3000-building snapshot per
 * frame would make timeline.json an order of magnitude larger for no gain.
 */
export function bucketTimeline(commits: Commit[], opts: BucketOptions): BucketResult {
  const bucket = chooseBucket(commits, opts.maxFrames);
  const n = opts.buildingCount;

  const fileLines = new Map<string, number>();
  const buildingLines = new Int32Array(n);
  const buildingTouch = new Int32Array(n);
  const dirty = new Set<number>();
  const frames: Frame[] = [];

  let totalLines = 0;
  let liveBuildings = 0;

  const chunkSize = bucket.kind === "chunk" ? Math.ceil(commits.length / opts.maxFrames) : 0;

  const flush = (ts: number, hash: string, commitCount: number) => {
    const delta: number[] = [];
    for (const i of dirty) {
      delta.push(i, buildingLines[i]);
    }
    dirty.clear();
    frames.push({
      ts,
      date: ymd(ts),
      commits: commitCount,
      hash: hash.slice(0, 7),
      buildings: liveBuildings,
      lines: totalLines,
      delta,
    });
  };

  let currentKey: number | null = null;
  let commitsInBucket = 0;
  let lastHash = "";
  let lastTs = 0;

  for (let ci = 0; ci < commits.length; ci++) {
    const c = commits[ci];

    const key =
      bucket.kind === "commit"
        ? ci
        : bucket.kind === "days"
          ? Math.floor(c.ts / (DAY * bucket.days))
          : Math.floor(ci / chunkSize);

    if (currentKey !== null && key !== currentKey) {
      flush(lastTs, lastHash, commitsInBucket);
      commitsInBucket = 0;
    }
    currentKey = key;
    commitsInBucket++;
    lastHash = c.hash;
    lastTs = c.ts;

    for (const f of c.files) {
      const bi = opts.pathToBuilding.get(f.path);
      if (bi === undefined) continue;

      const prev = fileLines.get(f.path) ?? 0;
      const next = f.binary ? Math.max(prev, 1) : Math.max(0, prev + f.added - f.removed);
      if (next === prev && buildingTouch[bi] !== 0) continue;
      fileLines.set(f.path, next);

      const before = buildingLines[bi];
      const after = before + (next - prev);
      buildingLines[bi] = after;
      totalLines += next - prev;

      if (before <= 0 && after > 0) liveBuildings++;
      else if (before > 0 && after <= 0) liveBuildings--;

      buildingTouch[bi] = c.ts;
      dirty.add(bi);
    }
  }

  if (currentKey !== null) flush(lastTs, lastHash, commitsInBucket);

  return {
    frames,
    bucket,
    final: { h: Array.from(buildingLines), t: Array.from(buildingTouch) },
  };
}
