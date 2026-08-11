/**
 * Screenshot harness for the reference-match loop.
 *
 *   bun run tools/shot.ts [--repo <slug>] [--out <file>] [--size 1672x941]
 *
 * Uses the locally installed Google Chrome so nothing extra has to download.
 */
import { chromium, type Browser } from "playwright";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: "chrome" });
  } catch {
    return await chromium.launch();
  }
}

async function main(): Promise<void> {
  const repo = arg("repo", "");
  const [w, h] = arg("size", "1672x941").split("x").map(Number);
  const base = arg("url", "http://127.0.0.1:5180");
  const out = path.resolve(ROOT, arg("out", `shots/${repo || "default"}-${w}x${h}.png`));
  await mkdir(path.dirname(out), { recursive: true });

  const browser = await launch();
  const page = await browser.newPage({
    viewport: { width: w, height: h },
    deviceScaleFactor: 1,
  });

  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  const url = repo ? `${base}/?repo=${repo}` : base;
  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });

  try {
    await page.waitForFunction(() => document.documentElement.dataset.cityReady === "1",
    undefined,
    {
      timeout: 45_000,
    });
  } catch {
    errors.push("timed out waiting for the scene to report ready");
  }

  // let orbit damping settle and bloom converge
  await page.waitForTimeout(1400);
  await page.screenshot({ path: out });

  // a few measurements to diff against the reference spec
  const measured = await page.evaluate(() => {
    const rect = (sel: string) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    };
    return {
      topbar: rect(".topbar"),
      rail: rect(".rail"),
      repo: rect("#panel-repo"),
      metrics: rect("#panel-metrics"),
      status: rect("#panel-status"),
      meta: rect(".meta"),
      scene: rect(".scene"),
      timeline: rect(".timeline"),
      compass: rect(".compass"),
      topview: rect(".compass__btn"),
      bg: getComputedStyle(document.body).backgroundColor,
      font: getComputedStyle(document.body).fontFamily.split(",")[0],
    };
  });

  await browser.close();

  process.stdout.write(`${JSON.stringify(measured, null, 2)}\n`);
  process.stdout.write(`\nwrote ${path.relative(ROOT, out)}\n`);
  if (errors.length) {
    process.stdout.write(`\nconsole errors:\n${errors.map((e) => `  ${e}`).join("\n")}\n`);
    process.exitCode = 1;
  }
}

void main();
