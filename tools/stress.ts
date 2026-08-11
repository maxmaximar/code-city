/**
 * Stress dataset generator.
 *
 *   bun run tools/stress.ts 50000
 *
 * Builds a synthetic repository of N eligible files and runs it through the
 * *real* layout, bucketing and serialization, so the resulting city exercises
 * every code path a cloned repository would. The shape is modelled on what the
 * cold-tested repositories actually look like: a few dominant packages, a long
 * tail of small folders, a log-normal spread of file sizes.
 *
 * This exists because the alternative — cloning a 4 GB monorepo — measures the
 * network, not the renderer.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLayout } from "../ingest/build-layout.js";
import { bucketTimeline } from "../ingest/bucket-timeline.js";
import { languageOf } from "../ingest/eligibility.js";
import { SCHEMA_VERSION, type CityData, type Commit } from "../ingest/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 86_400;

/** deterministic PRNG — the same N always produces the same city */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const PACKAGES = [
  "core", "runtime", "compiler", "renderer", "scheduler", "parser", "codegen",
  "server", "client", "shared", "cli", "devtools", "testing", "docs", "examples",
];
const AREAS = ["src", "lib", "internal", "utils", "types", "hooks", "adapters", "plugins", "__tests__"];
const EXT = [".ts", ".ts", ".tsx", ".js", ".md", ".json", ".css", ".py", ".go", ".rs"];

async function main(): Promise<void> {
  const target = Number(process.argv[2] ?? 30_000);
  const random = rng(0x5eed + target);

  // ── a plausible tree ─────────────────────────────────────────────────────
  const sizes = new Map<string, number>();
  const stats = new Map<string, { peak: number; final: number }>();
  const paths: string[] = [];

  while (paths.length < target) {
    // Zipf-ish: a few packages hold most of the files
    const pkg = PACKAGES[Math.floor(Math.pow(random(), 2.2) * PACKAGES.length)];
    const area = AREAS[Math.floor(random() * AREAS.length)];
    const depth = 1 + Math.floor(Math.pow(random(), 1.6) * 3);
    const parts = [`packages/${pkg}`, area];
    for (let d = 0; d < depth; d++) parts.push(`g${Math.floor(random() * 14)}`);
    const file = `f${paths.length.toString(36)}${EXT[Math.floor(random() * EXT.length)]}`;
    const p = `${parts.join("/")}/${file}`;
    if (sizes.has(p)) continue;

    // log-normal line counts, the way real source is distributed
    const lines = Math.max(1, Math.round(Math.exp(3 + random() * 2.6)));
    sizes.set(p, lines * (28 + Math.floor(random() * 22)));
    stats.set(p, { peak: lines, final: lines });
    paths.push(p);
  }

  // ── a plausible history ──────────────────────────────────────────────────
  const frames = 200;
  const now = Math.floor(Date.now() / 1000);
  const commits: Commit[] = [];
  for (let f = 0; f < frames; f++) {
    const ts = now - (frames - f) * 7 * DAY;
    const touched = Math.max(4, Math.round(target / frames));
    const files = [];
    for (let i = 0; i < touched; i++) {
      const p = paths[Math.floor(random() * paths.length)];
      files.push({ path: p, added: stats.get(p)!.final, removed: 0, binary: false });
    }
    commits.push({ hash: `c${f.toString(16).padStart(7, "0")}`, author: "stress", ts, subject: `frame ${f}`, files });
  }

  console.log(`generating ${paths.length.toLocaleString()} files across ${PACKAGES.length} packages…`);

  const t0 = Date.now();
  const layout = buildLayout(stats, sizes, { maxBuildings: 200_000, aggregateThreshold: 15 });
  const layoutMs = Date.now() - t0;

  const t1 = Date.now();
  const timeline = bucketTimeline(commits, {
    maxFrames: 240,
    pathToBuilding: layout.pathToBuilding,
    buildingCount: layout.buildings.length,
  });
  const bucketMs = Date.now() - t1;

  for (const d of layout.districts) d.lines = 0;
  layout.buildings.forEach((b, i) => {
    layout.districts[b.d].lines += timeline.final.h[i];
  });

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const d of layout.districts) {
    minX = Math.min(minX, d.px);
    maxX = Math.max(maxX, d.px + d.pw);
    minZ = Math.min(minZ, d.pz);
    maxZ = Math.max(maxZ, d.pz + d.pd);
  }

  const standing = timeline.final.h.reduce((c, h) => c + (h > 0 ? 1 : 0), 0);
  const totalLines = timeline.final.h.reduce((c, h) => c + h, 0);
  const languages = layout.languages;
  const slug = `stress-${paths.length}`;

  const data: CityData = {
    meta: {
      schema: SCHEMA_VERSION,
      repoName: `stress / ${paths.length.toLocaleString()} files`,
      repoUrl: "synthetic://stress",
      owner: "stress",
      name: String(paths.length),
      defaultBranch: "main",
      totalCommits: commits.length,
      authors: 1,
      totalPaths: paths.length,
      finalFiles: standing,
      finalLines: totalLines,
      lots: layout.buildings.length,
      standing,
      aggregates: layout.aggregates,
      districts: layout.districts.length,
      frames: timeline.frames.length,
      bucket: timeline.bucket.label,
      shallow: false,
      sampled: layout.sampled,
      firstCommit: commits[0].ts,
      lastCommit: commits[commits.length - 1].ts,
      generatedAt: Date.now(),
      ingestMs: layoutMs + bucketMs,
      steps: [
        { label: "synthetic repository", value: `${paths.length} files`, ms: 0 },
        { label: "building city layout", value: `${layout.buildings.length} lots`, ms: layoutMs },
        { label: "bucketing timeline", value: `${timeline.frames.length} frames`, ms: bucketMs },
        { label: "ready", value: null, ms: 0 },
      ],
      github: null,
      head: { hash: "stress", short: "stress", author: "stress", subject: "synthetic", ts: now },
      bytes: [...sizes.values()].reduce((a, b) => a + b, 0),
      filesAtHead: paths.length,
      eligibleFiles: paths.length,
      excluded: [],
      languageFiles: [...new Map(paths.map((p) => [languageOf(p), 0])).keys()].map((l) => [
        l,
        paths.filter((p) => languageOf(p) === l).length,
      ]) as Array<[string, number]>,
    },
    languages,
    districts: layout.districts,
    blocks: layout.blocks,
    buildings: layout.buildings,
    final: timeline.final,
    frames: timeline.frames,
  };

  const dir = path.join(ROOT, "data", "out");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${slug}.json`);
  const json = JSON.stringify(data);
  await writeFile(file, json);

  console.log(
    [
      `  lots        ${layout.buildings.length.toLocaleString()}`,
      `  districts   ${layout.districts.length}`,
      `  blocks      ${layout.blocks.length}`,
      `  city        ${Math.round(maxX - minX)} × ${Math.round(maxZ - minZ)}`,
      `  layout      ${layoutMs} ms`,
      `  bucketing   ${bucketMs} ms`,
      `  dataset     ${(json.length / 1e6).toFixed(1)} MB`,
      "",
      `  open        http://127.0.0.1:5180/?repo=${slug}`,
    ].join("\n"),
  );
}

void main();
