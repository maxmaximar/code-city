/**
 * Cold test: drive the real UI through the whole journey for repositories this
 * installation has never analyzed.
 *
 *   bun run tools/cold-test.ts [--keep] [--only <n>]
 *
 * Nothing here reads the ingest directly — every assertion is made against what
 * a person would actually see in the browser.
 */
import { chromium, type Page } from "playwright";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normaliseUrl } from "../ingest/clone.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://127.0.0.1:5180";

/** Structurally different, and deliberately including awkward shapes. */
const REPOS: Array<{ url: string; note: string }> = [
  { url: "https://github.com/sindresorhus/is-plain-obj", note: "tiny · a handful of files" },
  { url: "https://github.com/vercel/ms.git", note: "tiny · .git suffix" },
  { url: "https://github.com/github/gitignore", note: "unusual · no source code at all" },
  { url: "https://github.com/spf13/cobra", note: "small · flat Go package" },
  { url: "https://github.com/psf/requests", note: "small · Python, one src dir" },
  { url: "https://github.com/d3/d3.git", note: "small · one dominant src" },
  { url: "https://github.com/clap-rs/clap", note: "medium · Rust workspace" },
  { url: "https://github.com/google/gson", note: "medium · deep Maven nesting" },
  { url: "https://github.com/withastro/astro", note: "large · monorepo, many packages" },
  { url: "https://github.com/mrdoob/three.js", note: "very large · thousands of nested files" },
];

interface Result {
  url: string;
  note: string;
  slug: string;
  ok: boolean;
  ms: number;
  facts: Record<string, string | number>;
  failures: string[];
  consoleErrors: string[];
}

const IGNORED_CONSOLE = [
  /favicon/i,
  /ERR_INTERNET_DISCONNECTED/i,
  /Failed to load resource: the server responded with a status of 404/i,
];

async function textOf(page: Page, selector: string): Promise<string> {
  return (await page.locator(selector).first().textContent())?.trim() ?? "";
}

async function runOne(page: Page, repo: { url: string; note: string }, errors: string[]): Promise<Result> {
  const { slug } = normaliseUrl(repo.url);
  const failures: string[] = [];
  const facts: Record<string, string | number> = {};
  const started = Date.now();

  const fail = (why: string) => failures.push(why);

  await page.goto(`${BASE}/?fresh=1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#onboard-url", { state: "attached" });
  await page.waitForTimeout(400);

  // the overlay should already be up when there is nothing to show
  if (!(await page.evaluate(() => document.getElementById("onboard")?.classList.contains("is-open")))) {
    await page.locator("#new-repo").click();
    await page.waitForTimeout(300);
  }

  await page.fill("#onboard-url", repo.url);

  const stages = new Set<string>();
  const poll = setInterval(() => {
    void page
      .evaluate(() => document.querySelector("#onboard-stages li.is-active .stage__label")?.textContent ?? "")
      .then((s) => {
        if (s) stages.add(s);
      })
      .catch(() => {});
  }, 100);

  await page.click("#onboard-submit");

  try {
    await page.waitForFunction(
      () => !document.getElementById("onboard")?.classList.contains("is-open"),
    undefined,
    { timeout: 15 * 60_000 },
    );
  } catch (err) {
    clearInterval(poll);
    const shown = await textOf(page, "#onboard-error").catch(() => "");
    const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
    fail(`analysis never finished — ${why}${shown ? ` · overlay: ${shown}` : ""}`);
    return { url: repo.url, note: repo.note, slug, ok: false, ms: Date.now() - started, facts, failures, consoleErrors: [] };
  }
  clearInterval(poll);

  facts.stages = [...stages].join(" → ") || "(too fast to sample)";

  await page.waitForFunction(() => document.documentElement.dataset.cityReady === "1",
    undefined,
    { timeout: 90_000 });
  // let the construction sequence play out
  await page.waitForTimeout(4200);

  // ── the city itself ──────────────────────────────────────────────────────
  const city = await page.evaluate(() => {
    const w = window as unknown as { __codecity?: { city?: { visible: number }; data?: unknown } };
    const c = w.__codecity;
    const d = c?.data as
      | { buildings?: unknown[]; districts?: unknown[]; blocks?: unknown[]; meta?: Record<string, number> }
      | undefined;
    return {
      visible: c?.city?.visible ?? 0,
      lots: d?.buildings?.length ?? 0,
      districts: d?.districts?.length ?? 0,
      blocks: d?.blocks?.length ?? 0,
      filesAtHead: d?.meta?.filesAtHead ?? 0,
      eligible: d?.meta?.eligibleFiles ?? 0,
    };
  });
  Object.assign(facts, city);

  if (city.visible <= 0) fail("no buildings standing in the final frame");
  // the whole promise: one eligible file at HEAD, one standing building
  if (city.eligible > 0 && city.visible !== city.eligible) {
    fail(`${city.visible} buildings standing but ${city.eligible} eligible files at HEAD`);
  }
  if (city.districts <= 0) fail("no districts");
  if (city.lots < city.visible) fail("fewer lots than standing buildings");

  // ── metric agreement across the UI ───────────────────────────────────────
  const metricBuildings = Number((await textOf(page, "#m-buildings")).replace(/[^0-9]/g, ""));
  const timelineBuildings = Number((await textOf(page, "#c-buildings")).replace(/[^0-9]/g, ""));
  const statusText = await textOf(page, "#status-text");
  facts.metricBuildings = metricBuildings;

  if (metricBuildings !== city.visible) {
    fail(`§02 says ${metricBuildings} buildings, renderer has ${city.visible}`);
  }
  if (timelineBuildings !== city.visible) {
    fail(`timeline says ${timelineBuildings} buildings, renderer has ${city.visible}`);
  }
  if (!statusText.includes(String(city.visible).replace(/\B(?=(\d{3})+(?!\d))/g, ","))) {
    fail(`model-view line disagrees: "${statusText}"`);
  }

  // ── search + fly-to ──────────────────────────────────────────────────────
  await page.keyboard.press("/");
  await page.waitForTimeout(200);
  const probe = await page.evaluate(() => {
    const w = window as unknown as { __codecity: { data: { buildings: Array<{ n: string }> } } };
    const b = w.__codecity.data.buildings;
    return b.length > 0 ? b[Math.floor(b.length / 2)].n.slice(0, 12) : "";
  });
  await page.fill("#search-input", probe);
  await page.waitForTimeout(400);
  const hits = await page.locator("#search-results .hit").count();
  facts.searchHits = hits;
  if (hits === 0) fail(`search for "${probe}" returned nothing`);
  else {
    const before = await page.evaluate(() => JSON.stringify((window as any).__codecity.rig.camera.position));
    await page.locator("#search-results .hit").first().click();
    await page.waitForTimeout(1400);
    const after = await page.evaluate(() => JSON.stringify((window as any).__codecity.rig.camera.position));
    if (before === after) fail("selecting a search hit did not move the camera");
  }
  await page.keyboard.press("Escape");

  // ── picking resolves to the right file ───────────────────────────────────
  const pickOk = await page.evaluate(() => {
    const { city, THREE } = (window as any).__codecity;
    let best = -1;
    for (let i = 0; i < city.heights.length; i++) {
      if (best < 0 || city.heights[i] > city.heights[best]) best = i;
    }
    if (best < 0) return false;
    const p = city.anchorOf(best, new THREE.Vector3());
    const hit = city.pick(new THREE.Ray(new THREE.Vector3(p.x, 1000, p.z), new THREE.Vector3(0, -1, 0)));
    return !!hit && hit.index === best;
  });
  if (!pickOk) fail("a ray at a roof did not resolve to that building");

  // ── timeline ─────────────────────────────────────────────────────────────
  const frameBefore = await textOf(page, "#tl-frame");
  const plot = await page.locator("#tl-plot").boundingBox();
  if (plot) {
    await page.mouse.move(plot.x + plot.width * 0.3, plot.y + plot.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(600);
  }
  if ((await textOf(page, "#tl-frame")) === frameBefore) fail("timeline did not scrub");
  await page.keyboard.press("End");
  await page.waitForTimeout(500);

  // ── fullscreen ───────────────────────────────────────────────────────────
  await page.locator("#fullscreen").click();
  await page.waitForTimeout(400);
  if (!(await page.evaluate(() => document.querySelector(".app")?.classList.contains("is-fullscreen")))) {
    fail("fullscreen did not engage");
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  if (await page.evaluate(() => document.querySelector(".app")?.classList.contains("is-fullscreen"))) {
    fail("escape did not leave fullscreen");
  }

  // ── the three sections ───────────────────────────────────────────────────
  const sections = await page.evaluate(() => ({
    districts: document.querySelectorAll("#arch-grid .district").length,
    chartLines: document.querySelectorAll("#evo-chart .evo__line").length,
    diff: document.querySelectorAll("#evo-diff .cell").length,
    rows: document.querySelectorAll("#ex-rows .ex__row").length,
    excluded: document.querySelectorAll(".ex__excluded-row, .ex__none").length,
  }));
  Object.assign(facts, sections);
  if (sections.districts === 0) fail("architecture section is empty");
  if (sections.chartLines < 2) fail("evolution chart did not draw");
  if (sections.diff === 0) fail("compare produced no summary");
  if (sections.rows === 0) fail("explorer listed no files");
  if (sections.excluded === 0) fail("explorer did not report the exclusion breakdown");

  // ── reopen from cache ────────────────────────────────────────────────────
  const reopenStart = Date.now();
  await page.goto(`${BASE}/?repo=${slug}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.cityReady === "1",
    undefined,
    { timeout: 60_000 });
  facts.reopenMs = Date.now() - reopenStart;
  if (facts.reopenMs > 20_000) fail(`reopening from cache took ${facts.reopenMs}ms`);

  const relevant = errors.filter((e) => !IGNORED_CONSOLE.some((r) => r.test(e)));
  if (relevant.length > 0) fail(`console errors: ${relevant.slice(0, 2).join(" | ")}`);

  return {
    url: repo.url,
    note: repo.note,
    slug,
    ok: failures.length === 0,
    ms: Date.now() - started,
    facts,
    failures,
    consoleErrors: relevant,
  };
}

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  const onlyIndex = process.argv.indexOf("--only");
  const pick = process.argv.indexOf("--pick");
  const list =
    pick >= 0
      ? REPOS.filter((r) => r.url.includes(process.argv[pick + 1] ?? ""))
      : onlyIndex >= 0
        ? REPOS.slice(0, Number(process.argv[onlyIndex + 1]) || 1)
        : REPOS;

  // cold means cold: no clone, no dataset, nothing in the manifest
  if (!keep) {
    for (const repo of list) {
      const { slug } = normaliseUrl(repo.url);
      for (const p of [
        path.join(ROOT, "data", "cache", `${slug}.git`),
        path.join(ROOT, "data", "out", `${slug}.json`),
      ]) {
        if (existsSync(p)) await rm(p, { recursive: true, force: true });
      }
    }
  }

  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1672, height: 941 } });

  let errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 220));
  });

  const results: Result[] = [];
  for (const repo of list) {
    errors = [];
    process.stdout.write(`\n▸ ${repo.url}\n  ${repo.note}\n`);
    try {
      const result = await runOne(page, repo, errors);
      results.push(result);
      const facts = Object.entries(result.facts)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      process.stdout.write(`  ${result.ok ? "PASS" : "FAIL"} in ${(result.ms / 1000).toFixed(1)}s\n  ${facts}\n`);
      for (const f of result.failures) process.stdout.write(`    ✗ ${f}\n`);
    } catch (err) {
      results.push({
        url: repo.url,
        note: repo.note,
        slug: normaliseUrl(repo.url).slug,
        ok: false,
        ms: 0,
        facts: {},
        failures: [err instanceof Error ? err.message : String(err)],
        consoleErrors: errors,
      });
      process.stdout.write(`  FAIL — ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  await browser.close();

  const passed = results.filter((r) => r.ok).length;
  process.stdout.write(`\n${passed}/${results.length} repositories passed the cold test\n`);
  if (passed !== results.length) process.exitCode = 1;
}

void main();
