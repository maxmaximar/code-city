/**
 * Structural checks on the city itself, independent of how it looks.
 *
 *   bun run tools/validate.ts [slug ...]
 */
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { CityData } from "../ingest/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://127.0.0.1:5180";

let failures = 0;

function check(name: string, ok: boolean, note = ""): void {
  if (!ok) failures++;
  process.stdout.write(`  ${ok ? "ok  " : "FAIL"}  ${name}${note ? `  — ${note}` : ""}\n`);
}

interface Rect {
  x: number;
  z: number;
  w: number;
  h: number;
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.z < b.z + b.h && a.z + a.h > b.z;

/** everything about the layout that must be reproducible */
function fingerprint(city: CityData): string {
  const parts: string[] = [];
  for (const d of city.districts) parts.push(`D|${d.name}|${d.px}|${d.pz}|${d.pw}|${d.pd}`);
  for (const b of city.blocks) parts.push(`K|${b.path}|${b.x}|${b.z}|${b.w}|${b.h}`);
  for (const b of city.buildings) parts.push(`B|${b.p}|${b.d}|${b.k}|${b.x}|${b.z}`);
  let h1 = 0x811c9dc5;
  const joined = parts.join("\n");
  for (let i = 0; i < joined.length; i++) {
    h1 ^= joined.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return `${h1.toString(16)}:${parts.length}`;
}

async function load(slug: string): Promise<CityData> {
  return JSON.parse(await readFile(path.join(ROOT, "data", "out", `${slug}.json`), "utf8"));
}

async function geometry(slug: string): Promise<void> {
  const city = await load(slug);
  process.stdout.write(`\n${city.meta.repoName}  (${slug})\n`);

  // districts
  let districtHits = 0;
  const plates: Rect[] = city.districts.map((d) => ({ x: d.px, z: d.pz, w: d.pw, h: d.pd }));
  for (let i = 0; i < plates.length; i++) {
    for (let j = i + 1; j < plates.length; j++) if (overlaps(plates[i], plates[j])) districtHits++;
  }
  check("districts do not overlap", districtHits === 0, `${city.districts.length} districts`);

  // blocks
  let blockHits = 0;
  const blocks: Rect[] = city.blocks.map((b) => ({ x: b.x, z: b.z, w: b.w, h: b.h }));
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) if (overlaps(blocks[i], blocks[j])) blockHits++;
  }
  check("blocks do not overlap", blockHits === 0, `${city.blocks.length} blocks`);

  // every block inside its district plate
  let escaped = 0;
  city.blocks.forEach((b) => {
    const d = city.districts[b.d];
    if (b.x < d.px || b.z < d.pz || b.x + b.w > d.px + d.pw || b.z + b.h > d.pz + d.pd) escaped++;
  });
  check("blocks stay inside their district", escaped === 0);

  // every building inside its own block — this is what keeps buildings off the roads
  let strays = 0;
  let mismatched = 0;
  city.buildings.forEach((bd) => {
    const b = city.blocks[bd.k];
    if (!b) {
      mismatched++;
      return;
    }
    if (bd.x < b.x || bd.x > b.x + b.w || bd.z < b.z || bd.z > b.z + b.h) strays++;
    if (b.d !== bd.d) mismatched++;
  });
  check("buildings sit inside their own block", strays === 0 && mismatched === 0);

  // no two buildings on the same lot
  const lots = new Set<string>();
  let collisions = 0;
  for (const bd of city.buildings) {
    const key = `${bd.x.toFixed(3)},${bd.z.toFixed(3)}`;
    if (lots.has(key)) collisions++;
    lots.add(key);
  }
  check("one building per lot", collisions === 0, `${city.buildings.length} buildings`);

  const plazas = city.blocks.filter((b) => b.plaza).length;
  process.stdout.write(`        ${plazas} plazas · ${city.meta.frames} frames\n`);
}

async function determinism(repo: string, slug: string): Promise<void> {
  const before = fingerprint(await load(slug));
  spawnSync("bun", ["run", "bin/codecity.ts", repo, "--rebuild", "--quiet"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const after = fingerprint(await load(slug));
  check(`same repo rebuilds to the same city (${slug})`, before === after, before);
}

async function picking(slug: string): Promise<void> {
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1672, height: 941 } });
  await page.goto(`${BASE}/?repo=${slug}&still=1`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.documentElement.dataset.cityReady === "1",
    undefined,
    {
    timeout: 60_000,
  });
  await page.waitForTimeout(1600);

  // Fire rays straight at known building tops and confirm the picker returns
  // that exact building — the check that a click maps to the right file.
  const result = await page.evaluate(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const { data, city, THREE } = (window as any).__codecity;

    // pick a spread of standing buildings
    const standing: number[] = [];
    for (let i = 0; i < city.heights.length; i++) if (city.heights[i] > 1) standing.push(i);
    const sample = standing.filter((_, i) => i % Math.max(1, Math.floor(standing.length / 40)) === 0);

    let hit = 0;
    let tested = 0;
    const misses: string[] = [];

    // Straight down onto each roof centre. A ray from the camera can legitimately
    // be blocked by a taller tower in front, which would test occlusion rather
    // than correctness; a vertical ray can only hit the building it is aimed at.
    const scratch = new THREE.Vector3();
    const down = new THREE.Vector3(0, -1, 0);
    for (const index of sample.slice(0, 40)) {
      const target = city.anchorOf(index, scratch);
      const origin = new THREE.Vector3(target.x, 1000, target.z);
      const got = city.pick(new THREE.Ray(origin, down));
      tested++;
      if (got && got.index === index) hit++;
      else if (got) misses.push(`${data.buildings[index].p} → ${data.buildings[got.index].p}`);
      else misses.push(`${data.buildings[index].p} → nothing`);
    }
    return { hit, tested, misses: misses.slice(0, 3) };
  });

  check(
    `picking resolves to the right building (${slug})`,
    result.hit === result.tested,
    `${result.hit}/${result.tested}${result.misses.length ? ` · e.g. ${result.misses[0]}` : ""}`,
  );

  await browser.close();
}

async function main(): Promise<void> {
  const targets: Array<[string, string]> = [
    ["expressjs/express", "expressjs__express"],
    ["Graphify-Labs/graphify", "Graphify-Labs__graphify"],
    ["facebook/react", "facebook__react"],
    ["microsoft/TypeScript", "microsoft__TypeScript"],
  ];

  for (const [, slug] of targets) await geometry(slug);

  process.stdout.write("\ndeterminism\n");
  for (const [repo, slug] of targets.slice(0, 3)) await determinism(repo, slug);

  process.stdout.write("\npicking\n");
  for (const [, slug] of [targets[1], targets[2]]) await picking(slug);

  process.stdout.write(failures === 0 ? "\nall structural checks passed\n" : `\n${failures} failed\n`);
  if (failures) process.exitCode = 1;
}

void main();
