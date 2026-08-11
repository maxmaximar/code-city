/**
 * End-to-end check of the Day 2 interactions against the running dev server.
 *
 *   bun run tools/smoke.ts [--repo <slug>]
 */
import { chromium, type Page } from "playwright";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://127.0.0.1:5180";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const results: Array<{ name: string; ok: boolean; note: string }> = [];

function check(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok, note });
  process.stdout.write(`${ok ? "  ok  " : "  FAIL"}  ${name}${note ? `  — ${note}` : ""}\n`);
}

const frameOf = (page: Page) =>
  page.evaluate(() => document.getElementById("tl-frame")?.textContent ?? "");

async function main(): Promise<void> {
  const slug = arg("repo", "facebook__react");
  const shots = path.join(ROOT, "shots");
  await mkdir(shots, { recursive: true });

  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1672, height: 941 } });

  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${BASE}/?repo=${slug}`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForFunction(() => document.documentElement.dataset.cityReady === "1",
    undefined,
    {
    timeout: 45_000,
  });
  await page.waitForTimeout(2200);

  check("city renders", (await page.evaluate(() => {
    const w = window as unknown as { __codecity?: { city?: { visible: number } } };
    return w.__codecity?.city?.visible ?? 0;
  })) > 0);

  // ── scrubbing ────────────────────────────────────────────────────────────
  const before = await frameOf(page);
  const plot = await page.locator("#tl-plot").boundingBox();
  if (!plot) throw new Error("no timeline plot");

  await page.mouse.move(plot.x + plot.width * 0.32, plot.y + plot.height / 2);
  await page.mouse.down();
  await page.mouse.move(plot.x + plot.width * 0.34, plot.y + plot.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const afterScrub = await frameOf(page);
  check("timeline scrubs", before !== afterScrub, `${before} → ${afterScrub}`);

  const scrubbed = await page.evaluate(() => ({
    date: document.getElementById("c-date")?.textContent,
    loc: document.getElementById("c-loc")?.textContent,
    buildings: document.getElementById("m-buildings")?.textContent,
  }));
  check(
    "readouts follow the frame",
    Boolean(scrubbed.date && scrubbed.loc && scrubbed.buildings && scrubbed.date !== "—"),
    JSON.stringify(scrubbed),
  );

  await page.screenshot({ path: path.join(shots, "smoke-scrubbed.png") });

  // ── playback ─────────────────────────────────────────────────────────────
  await page.locator("#tl-play").click();
  await page.waitForTimeout(1500);
  const playingFrame = await frameOf(page);
  const isPlaying = await page.evaluate(() => document.getElementById("tl-play")?.classList.contains("is-playing") ?? false);
  check("playback advances", playingFrame !== afterScrub && isPlaying === true, playingFrame);

  await page.locator("#tl-play").click();
  await page.waitForTimeout(400);
  check(
    "pause stops it",
    (await page.evaluate(() => document.getElementById("tl-chip")?.textContent)) === "READY",
  );

  // ── speed ────────────────────────────────────────────────────────────────
  await page.locator("#tl-speed").click();
  check("speed cycles", (await page.locator("#tl-speed").textContent()) === "2x");

  // ── step ─────────────────────────────────────────────────────────────────
  const beforeStep = await frameOf(page);
  await page.locator("#tl-next").click();
  await page.waitForTimeout(300);
  check("step advances one frame", (await frameOf(page)) !== beforeStep);

  // ── selection ────────────────────────────────────────────────────────────
  await page.keyboard.press("End");
  await page.waitForTimeout(900);

  const canvas = await page.locator("#canvas").boundingBox();
  if (!canvas) throw new Error("no canvas");

  // Aim at a real building instead of sweeping the canvas: project a tall,
  // standing one to screen space and click exactly there.
  // Any residual camera motion — drift, or the ease back home after a scrub —
  // moves the target out from under the cursor between projecting it and
  // clicking it, so wait until the camera has actually stopped.
  await page.evaluate(() => (window as any).__codecity.rig.setDrift(false));
  await page.waitForFunction(
    () => {
      const w = window as any;
      const p = w.__codecity.rig.camera.position;
      const key = `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`;
      const same = w.__cameraStill === key;
      w.__cameraStill = key;
      return same;
    },
    undefined,
    { timeout: 15_000, polling: 260 },
  );

  const aim = await page.evaluate(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const { city, rig, THREE } = (window as any).__codecity;
    let best = -1;
    for (let i = 0; i < city.heights.length; i++) {
      if (best < 0 || city.heights[i] > city.heights[best]) best = i;
    }
    const p = city.anchorOf(best, new THREE.Vector3()).clone();
    p.y *= 0.8;
    p.project(rig.camera);
    return { x: (p.x * 0.5 + 0.5), y: (-p.y * 0.5 + 0.5), index: best };
  });

  let selected = false;
  let probes = 0;
  let diag = "";
  for (const [dx, dy] of [[0, 0], [0, 0.012], [0.008, 0], [-0.008, 0], [0, -0.012]]) {
    await page.mouse.move(
      canvas.x + (aim.x + dx) * canvas.width,
      canvas.y + (aim.y + dy) * canvas.height,
    );
    await page.waitForTimeout(200);
    if (!(await page.evaluate(() => document.getElementById("canvas")?.classList.contains("is-hit")))) {
      diag = await page.evaluate(
        ([px, py]) => {
          const c = document.getElementById("canvas") as HTMLCanvasElement;
          const r = c.getBoundingClientRect();
          const top = document.elementFromPoint(px, py);
          return `scrollY=${window.scrollY} rect=${r.x.toFixed(0)},${r.y.toFixed(0)},${r.width.toFixed(0)},${r.height.toFixed(0)} top=${top?.tagName}#${(top as HTMLElement)?.id}`;
        },
        [canvas.x + (aim.x + dx) * canvas.width, canvas.y + (aim.y + dy) * canvas.height],
      );
      continue;
    }
    probes++;
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(450);
    selected = await page.evaluate(() => {
      const node = document.getElementById("inspect");
      return !!node && !node.hidden && node.classList.contains("is-open");
    });
    if (selected) break;
  }

  const inspected = await page.evaluate(() => ({
    name: document.getElementById("inspect-name")?.textContent,
    loc: document.getElementById("inspect-loc")?.textContent,
    size: document.getElementById("inspect-size")?.textContent,
  }));
  check(
    "building select opens the inspector",
    selected,
    `${JSON.stringify(inspected)} aim=${aim.x.toFixed(3)},${aim.y.toFixed(3)} hits=${probes} ${diag}`,
  );
  await page.screenshot({ path: path.join(shots, "smoke-selected.png") });

  // ── flythrough ───────────────────────────────────────────────────────────
  await page.locator("#tl-fly").click();
  await page.waitForTimeout(1600);
  check(
    "flythrough runs",
    (await page.evaluate(() => document.getElementById("tl-fly")?.classList.contains("is-on"))) ?? false,
  );
  await page.screenshot({ path: path.join(shots, "smoke-flythrough.png") });
  await page.locator("#tl-fly").click();

  // ── search ───────────────────────────────────────────────────────────────
  await page.keyboard.press("/");
  await page.waitForTimeout(250);
  check("slash opens search", await page.evaluate(() => document.activeElement?.id === "search-input"));

  await page.fill("#search-input", "src");
  await page.waitForTimeout(350);
  const hits = await page.locator("#search-results .hit").count();
  check("search returns hits", hits > 0, `${hits} hits`);

  if (hits > 0) {
    const beforeCam = await page.evaluate(() => {
      const p = (window as any).__codecity.rig.camera.position;
      return [p.x, p.y, p.z].join(",");
    });
    await page.locator("#search-results .hit").first().click();
    await page.waitForTimeout(1500);
    const afterCam = await page.evaluate(() => {
      const p = (window as any).__codecity.rig.camera.position;
      return [p.x, p.y, p.z].join(",");
    });
    check("selecting a hit flies the camera", beforeCam !== afterCam);
  }

  // ── view modes ───────────────────────────────────────────────────────────
  await page.locator('#modes button[data-color="language"]').click();
  await page.waitForTimeout(400);
  check(
    "language colour mode applies",
    (await page.evaluate(() => (window as any).__codecity.city.colorMode())) === "language",
  );
  await page.locator('#modes button[data-color="recency"]').click();

  // ── fullscreen ───────────────────────────────────────────────────────────
  await page.locator("#fullscreen").click();
  await page.waitForTimeout(500);
  const fsState = await page.evaluate(() => {
    const app = document.querySelector(".app");
    const rail = document.querySelector<HTMLElement>(".rail");
    const bar = document.querySelector<HTMLElement>("#fsbar");
    return {
      on: !!app?.classList.contains("is-fullscreen"),
      railHidden: !rail || getComputedStyle(rail).display === "none",
      barShown: !!bar && getComputedStyle(bar).display !== "none",
    };
  });
  check("fullscreen hides the chrome", fsState.on && fsState.railHidden && fsState.barShown, JSON.stringify(fsState));
  await page.screenshot({ path: path.join(shots, "smoke-fullscreen.png") });

  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check(
    "escape exits fullscreen",
    !(await page.evaluate(() => document.querySelector(".app")?.classList.contains("is-fullscreen"))),
  );

  // ── sections ─────────────────────────────────────────────────────────────
  const sectionCounts = await page.evaluate(() => ({
    districts: document.querySelectorAll("#arch-grid .district").length,
    diffCells: document.querySelectorAll("#evo-diff .cell").length,
    rows: document.querySelectorAll("#ex-rows .ex__row").length,
    excluded: document.querySelectorAll(".ex__excluded-row").length,
  }));
  check(
    "product sections populate",
    sectionCounts.districts > 0 && sectionCounts.diffCells > 0 && sectionCounts.rows > 0,
    JSON.stringify(sectionCounts),
  );

  // ── onboarding ───────────────────────────────────────────────────────────
  await page.locator("#new-repo").click();
  await page.waitForTimeout(400);
  check(
    "onboarding opens",
    (await page.evaluate(() => document.getElementById("onboard")?.classList.contains("is-open"))) ?? false,
  );
  await page.screenshot({ path: path.join(shots, "smoke-onboarding.png") });
  await page.keyboard.press("Escape");

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  if (errors.length) process.stdout.write(`\nconsole errors:\n${errors.map((e) => `  ${e}`).join("\n")}\n`);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length || errors.length) process.exitCode = 1;
}

void main();
