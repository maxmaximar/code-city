import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { cloneRepo, currentBranch, fetchRepo, headCommit, headSha, normaliseUrl } from "./clone.js";
import { parseGitLog, censusTree, countCommits } from "./parse-git-log.js";
import { accumulateStats, bucketTimeline } from "./bucket-timeline.js";
import { buildLayout } from "./build-layout.js";
import { classify, languageOf, EXCLUSION_LABELS, type ExclusionReason } from "./eligibility.js";
import { fetchRepoMeta } from "./github.js";
import { SCHEMA_VERSION, type CityData, type IngestStep } from "./types.js";

export const STAGES = [
  "CLONING",
  "ANALYZING FILES",
  "PARSING HISTORY",
  "BUILDING CITY",
  "CITY READY",
] as const;

export type Stage = (typeof STAGES)[number];

export interface Progress {
  stage: Stage;
  detail: string;
  /** overall completion, 0…1 */
  pct: number;
}

/** Where each stage starts and ends on the overall bar. */
const SPAN: Record<Stage, [number, number]> = {
  CLONING: [0.02, 0.34],
  "ANALYZING FILES": [0.34, 0.44],
  "PARSING HISTORY": [0.44, 0.8],
  "BUILDING CITY": [0.8, 0.97],
  "CITY READY": [1, 1],
};

export interface IngestOptions {
  url: string;
  root: string;
  maxBuildings: number;
  maxFrames: number;
  aggregateThreshold: number;
  depth: number;
  /** re-clone from scratch */
  force: boolean;
  /** rebuild the city from the existing clone, ignoring the cached dataset */
  rebuild?: boolean;
  /** fetch new commits into an existing clone before rebuilding */
  resync?: boolean;
  noGithub: boolean;
  quiet: boolean;
  onProgress?: (p: Progress) => void;
}

export interface IngestOutcome {
  data: CityData;
  slug: string;
  outFile: string;
  /** true when nothing changed and the previous city was reused verbatim */
  fromCache: boolean;
}

const fmt = new Intl.NumberFormat("en-US");

export function outDir(root: string): string {
  return path.join(root, "data", "out");
}

export async function readCached(root: string, slug: string): Promise<CityData | null> {
  try {
    return JSON.parse(await readFile(path.join(outDir(root), `${slug}.json`), "utf8"));
  } catch {
    return null;
  }
}

export async function ingest(opts: IngestOptions): Promise<IngestOutcome> {
  const t0 = Date.now();
  const steps: IngestStep[] = [];
  const log = (s: string) => {
    if (!opts.quiet) process.stderr.write(`${s}\n`);
  };

  let stage: Stage = "CLONING";
  const emit = (detail: string, within = 0) => {
    const [lo, hi] = SPAN[stage];
    opts.onProgress?.({ stage, detail, pct: lo + (hi - lo) * Math.min(1, Math.max(0, within)) });
  };
  const enter = (next: Stage, detail = "") => {
    stage = next;
    emit(detail, 0);
  };

  const cacheDir = path.join(opts.root, "data", "cache");
  const { owner, name, slug } = normaliseUrl(opts.url);
  const gitDirGuess = path.join(cacheDir, `${slug}.git`);
  const alreadyCloned = existsSync(path.join(gitDirGuess, "HEAD"));

  // ── 1. CLONING ───────────────────────────────────────────────────────────
  enter("CLONING", alreadyCloned ? "checking for new commits" : "connecting");

  let clone;
  let changed = !alreadyCloned;

  if (alreadyCloned && !opts.force) {
    if (opts.resync) {
      const result = await fetchRepo(gitDirGuess, (line) => {
        const m = line.match(/(\d+)%/);
        emit(line.slice(0, 60), m ? Number(m[1]) / 100 : 0.5);
      });
      changed = result.changed;
    }
    clone = await cloneRepo({ url: opts.url, cacheDir, depth: opts.depth });
  } else {
    clone = await cloneRepo({
      url: opts.url,
      cacheDir,
      depth: opts.depth,
      force: opts.force,
      onLog: (line) => {
        const m = line.match(/(?:Receiving objects|Resolving deltas):\s+(\d+)%/);
        if (m) emit(`receiving objects ${m[1]}%`, Number(m[1]) / 100);
      },
    });
  }

  steps.push({ label: "cloned repository", value: clone.cached ? "cached" : null, ms: clone.ms });
  log(`  $ cloned repository${clone.cached ? " — cached" : ""}`);

  const head = await headCommit(clone.gitDir);
  const sha = head?.hash ?? (await headSha(clone.gitDir));

  // Nothing moved and we already have a city for this exact commit: reuse it.
  if (!opts.force && !opts.rebuild && !changed) {
    const cached = await readCached(opts.root, clone.slug);
    if (
      cached &&
      cached.meta.schema === SCHEMA_VERSION &&
      cached.meta.head?.hash === sha &&
      cached.meta.lots > 0
    ) {
      enter("CITY READY", "unchanged since last sync");
      return { data: cached, slug: clone.slug, outFile: path.join(outDir(opts.root), `${clone.slug}.json`), fromCache: true };
    }
  }

  const branch = await currentBranch(clone.gitDir);

  // ── 2. ANALYZING FILES ───────────────────────────────────────────────────
  enter("ANALYZING FILES", "reading tree at HEAD");
  const census = await censusTree(clone.gitDir);
  emit(`${fmt.format(census.files)} files`, 0.6);
  const expectedCommits = await countCommits(clone.gitDir);
  emit(`${fmt.format(census.files)} files · ${fmt.format(expectedCommits)} commits`, 1);

  // ── 3. PARSING HISTORY ───────────────────────────────────────────────────
  enter("PARSING HISTORY", "git log --numstat");
  const parseStart = Date.now();
  const parsed = await parseGitLog({
    gitDir: clone.gitDir,
    onProgress: (n) => emit(`${fmt.format(n)} commits`, expectedCommits ? n / expectedCommits : 0.5),
  });
  steps.push({ label: "parsing git log --numstat", value: null, ms: Date.now() - parseStart });
  steps.push({ label: `${fmt.format(parsed.commits.length)} commits parsed`, value: null, ms: 0 });
  log(`  $ ${fmt.format(parsed.commits.length)} commits parsed`);

  if (parsed.commits.length === 0) {
    throw new Error("no commits found — is the repository empty?");
  }

  // ── 4. BUILDING CITY ─────────────────────────────────────────────────────
  enter("BUILDING CITY", "replaying history");
  const stats = accumulateStats(parsed.commits);

  // One eligible file, one building. Nothing is sampled away; what is dropped
  // is only what would not be a building in any meaningful sense, and every
  // category is counted so the UI can say exactly what went and why.
  const excludedCounts = new Map<string, number>();
  const languageFiles = new Map<string, number>();
  for (const [path, size] of census.sizes) {
    const verdict = classify(path, size);
    if (verdict.eligible) {
      const language = languageOf(path);
      languageFiles.set(language, (languageFiles.get(language) ?? 0) + 1);
    } else {
      excludedCounts.set(verdict.reason!, (excludedCounts.get(verdict.reason!) ?? 0) + 1);
    }
  }

  // A path that no longer exists still deserves a plot — that is what makes the
  // time-lapse show a repository losing code, not just gaining it. But a file
  // that never grew past a stub is not a building, and an old repository can
  // easily have deleted more files than it kept, which would leave the finished
  // city standing in empty lots. So: a floor on size, and a hard cap on how much
  // of the city history is allowed to occupy, taking the largest ones.
  // Deleted files earn a plot only if they were substantial, and together they
  // never take more than this share of the city. Above roughly a third, the
  // finished city reads as half-empty lots rather than a place.
  const HISTORY_FLOOR = 60;
  const HISTORY_SHARE = 0.38;

  // The tree census is the authority on what the repository *is*, in both
  // directions. History is parsed with `--all`, so a file added on an unmerged
  // branch accumulates lines without existing at HEAD; and an empty file, or one
  // git never reported a line count for, exists at HEAD without ever
  // accumulating any. Left alone, either one makes the city disagree with the
  // repository it claims to be.
  for (const [path, stat] of stats.stats) {
    if (stat.final > 0 && !census.sizes.has(path)) stat.final = 0;
  }
  for (const [path, size] of census.sizes) {
    if (!classify(path, size).eligible) continue;
    const stat = stats.stats.get(path);
    if (!stat) stats.stats.set(path, { peak: 1, final: 1 });
    else if (stat.final <= 0) stat.final = 1;
  }

  const ghosts: Array<{ path: string; peak: number }> = [];
  let liveLots = 0;

  for (const [path, stat] of [...stats.stats.entries()]) {
    if (!classify(path, census.sizes.get(path)).eligible) {
      stats.stats.delete(path);
      continue;
    }
    if (stat.final > 0) {
      liveLots++;
      continue;
    }
    if (stat.peak < HISTORY_FLOOR) {
      stats.stats.delete(path);
      continue;
    }
    ghosts.push({ path, peak: stat.peak });
  }

  const ghostBudget = Math.round(liveLots * HISTORY_SHARE);
  if (ghosts.length > ghostBudget) {
    ghosts.sort((a, b) => b.peak - a.peak || (a.path < b.path ? -1 : 1));
    for (const ghost of ghosts.slice(ghostBudget)) stats.stats.delete(ghost.path);
  }
  const eligibleAtHead = census.files - [...excludedCounts.values()].reduce((a, b) => a + b, 0);

  emit("placing districts", 0.35);
  const layout = buildLayout(stats.stats, census.sizes, {
    maxBuildings: opts.maxBuildings,
    aggregateThreshold: opts.aggregateThreshold,
  });

  emit("bucketing timeline", 0.7);
  const timeline = bucketTimeline(parsed.commits, {
    maxFrames: opts.maxFrames,
    pathToBuilding: layout.pathToBuilding,
    buildingCount: layout.buildings.length,
  });

  // The last frame has to *be* HEAD. Replaying `git log --all` can leave a file
  // standing that only ever existed on an unmerged branch, so the tree census
  // gets the final word: any building with no file at HEAD is demolished, and
  // the correction is written into the last frame's delta so a replay to the
  // end lands on exactly the same city.
  {
    const hasHeadFile = new Uint8Array(layout.buildings.length);
    for (const [file, index] of layout.pathToBuilding) {
      if (census.sizes.has(file)) hasHeadFile[index] = 1;
    }
    const last = timeline.frames[timeline.frames.length - 1];
    let corrected = 0;
    for (let i = 0; i < layout.buildings.length; i++) {
      const standing = timeline.final.h[i] > 0;
      if (standing === Boolean(hasHeadFile[i])) continue;
      // demolish what HEAD does not have; raise what it does
      timeline.final.h[i] = standing ? 0 : 1;
      last.delta.push(i, timeline.final.h[i]);
      if (!standing && timeline.final.t[i] === 0) timeline.final.t[i] = last.ts;
      corrected++;
    }
    if (corrected > 0) {
      let standing = 0;
      let lines = 0;
      for (const h of timeline.final.h) {
        if (h > 0) {
          standing++;
          lines += h;
        }
      }
      last.buildings = standing;
      last.lines = lines;
      log(`  $ reconciled ${corrected} buildings against the tree at HEAD`);
    }
  }

  steps.push({
    label: "bucketing timeline",
    value: `${fmt.format(timeline.frames.length)} frames`,
    ms: 0,
  });
  steps.push({
    label: "building city layout",
    value: `${fmt.format(layout.buildings.length)} lots`,
    ms: 0,
  });
  log(`  $ bucketing timeline — ${timeline.frames.length} frames (${timeline.bucket.label})`);
  log(`  $ building city layout — ${layout.buildings.length} buildings`);

  for (const d of layout.districts) d.lines = 0;
  layout.buildings.forEach((b, i) => {
    layout.districts[b.d].lines += timeline.final.h[i];
  });

  emit("fetching repository metadata", 0.9);
  const isGithub = /^https:\/\/github\.com\//i.test(clone.url);
  const github =
    opts.noGithub || !isGithub ? null : await fetchRepoMeta(clone.owner ?? owner, clone.name ?? name);

  steps.push({ label: "ready", value: null, ms: 0 });

  const data: CityData = {
    meta: {
      schema: SCHEMA_VERSION,
      repoName: [clone.owner ?? owner, clone.name ?? name].filter(Boolean).join(" / ") || clone.slug,
      repoUrl: clone.url,
      owner: clone.owner ?? owner,
      name: clone.name ?? name,
      defaultBranch: branch,
      totalCommits: parsed.commits.length,
      authors: parsed.authors,
      totalPaths: stats.stats.size,
      finalFiles: census.files || stats.finalFiles,
      finalLines: stats.finalLines,
      lots: layout.buildings.length,
      standing: timeline.final.h.reduce((count, h) => count + (h > 0 ? 1 : 0), 0),
      aggregates: layout.aggregates,
      districts: layout.districts.length,
      frames: timeline.frames.length,
      bucket: timeline.bucket.label,
      shallow: clone.shallow,
      sampled: layout.sampled,
      firstCommit: stats.firstTs,
      lastCommit: stats.lastTs,
      generatedAt: Date.now(),
      ingestMs: Date.now() - t0,
      steps,
      github,
      head,
      bytes: census.bytes,
      filesAtHead: census.files,
      eligibleFiles: eligibleAtHead,
      excluded: [...excludedCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, files]) => ({
          reason,
          label: EXCLUSION_LABELS[reason as ExclusionReason] ?? reason,
          files,
        })),
      languageFiles: [...languageFiles.entries()].sort((a, b) => b[1] - a[1]),
    },
    languages: layout.languages,
    districts: layout.districts,
    blocks: layout.blocks,
    buildings: layout.buildings,
    final: timeline.final,
    frames: timeline.frames,
  };

  const dir = outDir(opts.root);
  await mkdir(dir, { recursive: true });
  const outFile = path.join(dir, `${clone.slug}.json`);
  await writeFile(outFile, JSON.stringify(data));
  await updateManifest(dir, clone.slug, data);

  enter("CITY READY", `${fmt.format(layout.buildings.length)} buildings`);
  return { data, slug: clone.slug, outFile, fromCache: false };
}

interface ManifestEntry {
  slug: string;
  /** the SCHEMA_VERSION this entry's dataset was written with */
  schema: number;
  repoName: string;
  repoUrl: string;
  /** plots reserved, history included */
  lots: number;
  /** buildings standing at HEAD */
  standing: number;
  districts: number;
  frames: number;
  commits: number;
  files: number;
  lines: number;
  sampled: boolean;
  generatedAt: number;
}

async function updateManifest(dir: string, slug: string, data: CityData): Promise<void> {
  const file = path.join(dir, "manifest.json");
  let manifest: { default: string; repos: ManifestEntry[] } = { default: slug, repos: [] };
  try {
    manifest = JSON.parse(await readFile(file, "utf8"));
  } catch {
    /* first run */
  }

  const entry: ManifestEntry = {
    slug,
    schema: data.meta.schema,
    repoName: data.meta.repoName,
    repoUrl: data.meta.repoUrl,
    lots: data.meta.lots,
    standing: data.meta.standing,
    districts: data.meta.districts,
    frames: data.meta.frames,
    commits: data.meta.totalCommits,
    files: data.meta.finalFiles,
    lines: data.meta.finalLines,
    sampled: data.meta.sampled,
    generatedAt: data.meta.generatedAt,
  };

  manifest.repos = [entry, ...(manifest.repos ?? []).filter((r) => r.slug !== slug)];
  manifest.default = slug;
  await writeFile(file, JSON.stringify(manifest, null, 2));
}
