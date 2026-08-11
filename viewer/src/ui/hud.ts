import type { CityData } from "../../../ingest/types.js";
import type { CityMetrics } from "../data/metrics.js";
import { ago, compact, n } from "../util/format.js";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

function set(id: string, value: string): void {
  el(id).textContent = value;
}

/**
 * Everything in the HUD comes from the ingested repository. Where a number is
 * not available for a given repo it reads `—` rather than a plausible-looking
 * placeholder.
 */
export function renderRepoPanel(data: CityData): void {
  const meta = data.meta;

  const name = el("repo-name");
  name.textContent = "";
  if (meta.owner && meta.name) {
    name.append(meta.owner);
    const slash = document.createElement("s");
    slash.textContent = "/";
    name.append(slash, meta.name);
  } else {
    name.append(meta.repoName);
  }

  set("repo-url", meta.repoUrl.replace(/\.git$/, ""));

  set("s-stars", meta.github ? n(meta.github.stars) : "—");
  set("s-forks", meta.github ? n(meta.github.forks) : "—");
  set("s-contrib", n(meta.authors));
  set("s-commits", n(meta.totalCommits));
  set("s-files", n(meta.finalFiles));
  set("s-loc", compact(meta.finalLines));

  const head = meta.head;
  set("repo-head", head ? head.short : "—");
  set(
    "repo-head-date",
    head ? new Date(head.ts * 1000).toISOString().slice(0, 10) : "—",
  );
  el("repo-head-subject").textContent = head?.subject ?? "";
  el("repo-head-subject").title = head ? `${head.subject} — ${head.author}` : "";

  set("repo-updated", `SYNCED ${ago(meta.generatedAt)}`);
}

/** `SYNCED` after a fetch, `CACHED` when the stored city was reused verbatim. */
export function setSyncState(state: "SYNCING" | "SYNCED" | "CACHED" | "STALE"): void {
  const chip = el("repo-chip");
  chip.textContent = state;
  chip.parentElement?.classList.toggle("chip--busy", state === "SYNCING");
}

export function setSessionState(text: string, busy: boolean): void {
  const chip = el("session-chip");
  chip.textContent = text;
  chip.parentElement?.classList.toggle("chip--busy", busy);
}

export function renderMetricsPanel(metrics: CityMetrics): void {
  set("m-density", metrics.density.toFixed(2));
  const churn = metrics.churnPctPerDay;
  set("m-churn", `${churn.toFixed(churn < 1 ? 2 : churn < 10 ? 1 : 0)}% / day`);
  const g = metrics.growthLocPerDay;
  set("m-growth", `${g >= 0 ? "+" : "−"}${compact(Math.abs(g))} LOC / day`);
  set("m-buildings", n(metrics.buildings));
  set("m-districts", n(metrics.districts));
  set("m-avg", `${n(metrics.avgHeight)} LOC`);
}

export function renderStatusPanel(data: CityData): void {
  const list = el("log");
  list.textContent = "";

  for (const step of data.meta.steps) {
    const li = document.createElement("li");

    const prefix = document.createElement("b");
    prefix.textContent = "$";

    const label = document.createElement("span");
    label.textContent = step.label;

    li.append(prefix, label);

    if (step.value === null) {
      const ok = document.createElement("i");
      ok.className = "ok";
      ok.textContent = "✓";
      li.append(ok);
    } else {
      const val = document.createElement("i");
      val.className = "val";
      val.textContent = step.value;
      li.append(val);
    }
    list.append(li);
  }
}

export function renderMetaStrip(data: CityData): void {
  set("meta-branch", data.meta.defaultBranch || "—");
  set("meta-frames", `${n(data.meta.frames)} FRAMES`);
  set("meta-bucket", data.meta.bucket.toUpperCase());
  set("meta-sample", data.meta.sampled ? "ADAPTIVE" : "FULL");
}

/** `$ frame 142 / 231 · 1,750 buildings · 1.17M LOC` */
export function renderStatusLine(
  frame: number,
  frames: number,
  buildings: number,
  lines: number,
): void {
  const node = el("status-text");
  node.textContent = "";
  const parts = [
    `frame ${n(frame)} / ${n(frames)}`,
    `${n(buildings)} buildings`,
    `${compact(lines)} LOC`,
  ];
  parts.forEach((part, i) => {
    if (i > 0) {
      const sep = document.createElement("em");
      sep.textContent = "·";
      node.append(sep);
    }
    node.append(part);
  });
}

export function setStatusMessage(text: string): void {
  el("status-text").textContent = text;
}

export function setViewMode(mode: "ORBIT" | "TOP" | "FLIGHT"): void {
  el("view-chip").textContent = mode;
}

export function setNeedleRotation(degrees: number): void {
  el("needle").style.transform = `rotate(${degrees}deg)`;
}
