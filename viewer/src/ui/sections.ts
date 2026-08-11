import type { CityData } from "../../../ingest/types.js";
import { bytes, compact, n } from "../util/format.js";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export interface SectionCallbacks {
  onFocusDistrict(index: number): void;
  onFocusBuilding(index: number): void;
  onSeek(frame: number): void;
  /** line counts for every building at a given frame, as a fresh copy */
  snapshotAt(frame: number): Int32Array;
}

export interface Sections {
  mount(data: CityData): void;
  /** keep the live readouts in step with the city's current frame */
  setFrame(frame: number): void;
}

const DAY = 86_400;
const EXPLORER_PAGE = 120;

type SortKey = "loc" | "size" | "recent" | "path";

export function createSections(cb: SectionCallbacks): Sections {
  let data: CityData | null = null;
  let finalLines: Int32Array = new Int32Array(0);

  // ── §05 architecture ─────────────────────────────────────────────────────
  const archGrid = el("arch-grid");
  const archSummary = el("arch-summary");

  function renderArchitecture(): void {
    if (!data) return;
    const city = data;
    const totalLines = city.districts.reduce((s, d) => s + d.lines, 0) || 1;
    const recentCut = city.meta.lastCommit - 90 * DAY;

    const recentByDistrict = new Array<number>(city.districts.length).fill(0);
    const standingByDistrict = new Array<number>(city.districts.length).fill(0);
    city.buildings.forEach((b, i) => {
      if (city.final.h[i] <= 0) return;
      standingByDistrict[b.d]++;
      if (city.final.t[i] >= recentCut) recentByDistrict[b.d]++;
    });

    const order = city.districts
      .map((d, i) => ({ d, i }))
      .sort((a, b) => b.d.lines - a.d.lines || b.d.lots - a.d.lots);

    archSummary.textContent = `${n(city.districts.length)} districts · ${n(city.blocks.length)} blocks · ${n(city.meta.standing)} buildings on ${n(city.buildings.length)} lots`;

    archGrid.textContent = "";
    for (const { d, i } of order) {
      const share = d.lines / totalLines;
      const standing = standingByDistrict[i];
      const recent = standing > 0 ? recentByDistrict[i] / standing : 0;

      const card = document.createElement("button");
      card.type = "button";
      card.className = "district";
      card.style.setProperty("--share", `${(share * 100).toFixed(2)}%`);

      const head = document.createElement("header");
      const name = document.createElement("b");
      name.textContent = d.name.toUpperCase();
      const path = document.createElement("i");
      path.textContent = d.path;
      head.append(name, path);

      const stats = document.createElement("div");
      stats.className = "district__stats";
      const cells: Array<[string, string]> = [
        ["LOTS", n(d.lots)],
        ["LINES", compact(d.lines)],
        ["SHARE", `${(share * 100).toFixed(1)}%`],
        ["RECENT", `${Math.round(recent * 100)}%`],
      ];
      for (const [k, v] of cells) {
        const cell = document.createElement("span");
        const key = document.createElement("em");
        key.textContent = k;
        const value = document.createElement("strong");
        value.textContent = v;
        cell.append(key, value);
        stats.append(cell);
      }

      const bar = document.createElement("div");
      bar.className = "district__bar";
      const fill = document.createElement("i");
      fill.style.width = `${Math.max(1.5, share * 100).toFixed(2)}%`;
      bar.append(fill);

      card.append(head, stats, bar);
      card.addEventListener("click", () => cb.onFocusDistrict(i));
      archGrid.append(card);
    }
  }

  // ── §06 evolution ────────────────────────────────────────────────────────
  const chart = el<SVGSVGElement & HTMLElement>("evo-chart");
  const evoMeta = el("evo-meta");
  const selectA = el<HTMLInputElement>("evo-a");
  const selectB = el<HTMLInputElement>("evo-b");
  const labelA = el("evo-a-label");
  const labelB = el("evo-b-label");
  const diffOut = el("evo-diff");

  function path(values: number[], w: number, h: number, pad: number): string {
    const max = Math.max(1, ...values);
    return values
      .map((v, i) => {
        const x = pad + (i / Math.max(1, values.length - 1)) * (w - pad * 2);
        const y = h - pad - (v / max) * (h - pad * 2);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }

  function renderEvolution(): void {
    if (!data) return;
    const frames = data.frames;
    const w = 1200;
    const h = 260;
    const pad = 14;

    chart.setAttribute("viewBox", `0 0 ${w} ${h}`);
    chart.textContent = "";

    const ns = "http://www.w3.org/2000/svg";
    const add = (tag: string, attrs: Record<string, string>) => {
      const node = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      chart.append(node);
      return node;
    };

    // commit volume as columns, then LOC and building count as lines over it
    const maxCommits = Math.max(1, ...frames.map((f) => f.commits));
    const colW = (w - pad * 2) / frames.length;
    frames.forEach((f, i) => {
      const barH = (f.commits / maxCommits) * (h - pad * 2) * 0.55;
      add("rect", {
        x: (pad + i * colW).toFixed(2),
        y: (h - pad - barH).toFixed(2),
        width: Math.max(0.6, colW - 0.8).toFixed(2),
        height: barH.toFixed(2),
        class: "evo__bar",
      });
    });

    add("path", { d: path(frames.map((f) => f.lines), w, h, pad), class: "evo__line evo__line--loc" });
    add("path", {
      d: path(frames.map((f) => f.buildings), w, h, pad),
      class: "evo__line evo__line--buildings",
    });

    const last = frames[frames.length - 1];
    const first = frames[0];
    const years = (last.ts - first.ts) / (365 * DAY);
    evoMeta.textContent = `${n(frames.length)} frames · ${data.meta.bucket} buckets · ${years.toFixed(1)} years · ${n(data.meta.totalCommits)} commits`;

    selectA.max = String(frames.length - 1);
    selectB.max = String(frames.length - 1);
    selectA.value = String(Math.floor(frames.length * 0.45));
    selectB.value = String(frames.length - 1);
    renderCompare();
  }

  function frameLabel(index: number): string {
    if (!data) return "—";
    const f = data.frames[Math.min(data.frames.length - 1, Math.max(0, index))];
    return `${f.date}  ·  ${f.hash}`;
  }

  function renderCompare(): void {
    if (!data) return;
    const a = Math.min(Number(selectA.value), Number(selectB.value));
    const b = Math.max(Number(selectA.value), Number(selectB.value));

    labelA.textContent = frameLabel(a);
    labelB.textContent = frameLabel(b);

    const before = cb.snapshotAt(a);
    const after = cb.snapshotAt(b);

    let added = 0;
    let removed = 0;
    let grown = 0;
    let shrunk = 0;
    let locBefore = 0;
    let locAfter = 0;
    const districtDelta = new Map<number, number>();

    for (let i = 0; i < before.length; i++) {
      const x = before[i];
      const y = after[i];
      locBefore += x;
      locAfter += y;
      if (x === y) continue;
      if (x === 0) added++;
      else if (y === 0) removed++;
      else if (y > x) grown++;
      else shrunk++;
      const d = data.buildings[i].d;
      districtDelta.set(d, (districtDelta.get(d) ?? 0) + (y - x));
    }

    diffOut.textContent = "";

    const summary = document.createElement("div");
    summary.className = "diff__summary";
    const cells: Array<[string, string, string]> = [
      ["ADDED", n(added), "up"],
      ["REMOVED", n(removed), "down"],
      ["GROWN", n(grown), "up"],
      ["REDUCED", n(shrunk), "down"],
      ["LINES", `${locAfter - locBefore >= 0 ? "+" : "−"}${compact(Math.abs(locAfter - locBefore))}`, locAfter >= locBefore ? "up" : "down"],
      ["SPAN", `${Math.round((data.frames[b].ts - data.frames[a].ts) / DAY)} days`, ""],
    ];
    for (const [k, v, tone] of cells) {
      const cell = document.createElement("div");
      cell.className = `cell${tone ? ` is-${tone}` : ""}`;
      const key = document.createElement("span");
      key.className = "cell__k";
      key.textContent = k;
      const value = document.createElement("span");
      value.className = "cell__v";
      value.textContent = v;
      cell.append(key, value);
      summary.append(cell);
    }
    diffOut.append(summary);

    const movers = [...districtDelta.entries()]
      .filter(([, delta]) => delta !== 0)
      .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))
      .slice(0, 8);

    if (movers.length > 0) {
      const list = document.createElement("div");
      list.className = "diff__movers";
      const peak = Math.max(...movers.map(([, delta]) => Math.abs(delta)));
      for (const [district, delta] of movers) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = `mover${delta >= 0 ? " is-up" : " is-down"}`;
        const name = document.createElement("b");
        name.textContent = data.districts[district].path;
        const bar = document.createElement("i");
        bar.style.width = `${Math.max(2, (Math.abs(delta) / peak) * 100).toFixed(1)}%`;
        const value = document.createElement("s");
        value.textContent = `${delta >= 0 ? "+" : "−"}${compact(Math.abs(delta))}`;
        row.append(name, bar, value);
        row.addEventListener("click", () => cb.onFocusDistrict(district));
        list.append(row);
      }
      diffOut.append(list);
    }
  }

  selectA.addEventListener("input", renderCompare);
  selectB.addEventListener("input", renderCompare);
  el("evo-jump-a").addEventListener("click", () => cb.onSeek(Number(selectA.value)));
  el("evo-jump-b").addEventListener("click", () => cb.onSeek(Number(selectB.value)));

  // ── §07 explorer ─────────────────────────────────────────────────────────
  const exQuery = el<HTMLInputElement>("ex-query");
  const exLanguage = el<HTMLSelectElement>("ex-language");
  const exDistrict = el<HTMLSelectElement>("ex-district");
  const exSort = el<HTMLSelectElement>("ex-sort");
  const exRows = el("ex-rows");
  const exCount = el("ex-count");
  const exCoverage = el("ex-coverage");
  const exExcluded = el("ex-excluded");

  let shown = EXPLORER_PAGE;

  function renderCoverage(): void {
    if (!data) return;
    const meta = data.meta;
    const standing = finalLines.reduce((s, v) => s + (v > 0 ? 1 : 0), 0);

    exCoverage.textContent = "";
    const facts: Array<[string, string]> = [
      ["FILES AT HEAD", n(meta.filesAtHead)],
      ["ELIGIBLE FILES", n(meta.eligibleFiles)],
      ["BUILDINGS", n(standing)],
      ["LOTS (WITH HISTORY)", n(data.buildings.length)],
    ];
    for (const [k, v] of facts) {
      const cell = document.createElement("div");
      cell.className = "cell";
      const key = document.createElement("span");
      key.className = "cell__k";
      key.textContent = k;
      const value = document.createElement("span");
      value.className = "cell__v";
      value.textContent = v;
      cell.append(key, value);
      exCoverage.append(cell);
    }

    exExcluded.textContent = "";
    if (meta.excluded.length === 0) {
      const none = document.createElement("p");
      none.className = "ex__none";
      none.textContent = "Nothing was excluded — every file at HEAD is a building.";
      exExcluded.append(none);
      return;
    }
    for (const item of meta.excluded) {
      const row = document.createElement("div");
      row.className = "ex__excluded-row";
      const name = document.createElement("b");
      name.textContent = item.reason.toUpperCase();
      const count = document.createElement("s");
      count.textContent = `${n(item.files)} files`;
      const why = document.createElement("i");
      why.textContent = item.label;
      row.append(name, count, why);
      exExcluded.append(row);
    }
  }

  function explorerRows(): number[] {
    if (!data) return [];
    const city = data;
    const needle = exQuery.value.trim().toLowerCase();
    const language = exLanguage.value;
    const district = exDistrict.value === "" ? -1 : Number(exDistrict.value);
    const key = exSort.value as SortKey;

    const rows: number[] = [];
    for (let i = 0; i < city.buildings.length; i++) {
      const b = city.buildings[i];
      if (district >= 0 && b.d !== district) continue;
      if (language && city.languages[b.l] !== language) continue;
      if (needle && !b.p.toLowerCase().includes(needle)) continue;
      rows.push(i);
    }

    const cmp: Record<SortKey, (x: number, y: number) => number> = {
      loc: (x, y) => finalLines[y] - finalLines[x],
      size: (x, y) => city.buildings[y].b - city.buildings[x].b,
      recent: (x, y) => city.final.t[y] - city.final.t[x],
      path: (x, y) => (city.buildings[x].p < city.buildings[y].p ? -1 : 1),
    };
    rows.sort(cmp[key]);
    return rows;
  }

  function renderExplorer(): void {
    if (!data) return;
    const city = data;
    const rows = explorerRows();
    exCount.textContent = `${n(rows.length)} matching · showing ${n(Math.min(shown, rows.length))}`;

    exRows.textContent = "";
    for (const i of rows.slice(0, shown)) {
      const b = city.buildings[i];
      const row = document.createElement("button");
      row.type = "button";
      row.className = `ex__row${finalLines[i] > 0 ? "" : " is-gone"}`;

      const cells: string[] = [
        b.p,
        city.districts[b.d].name,
        city.languages[b.l],
        finalLines[i] > 0 ? n(finalLines[i]) : "—",
        b.b > 0 ? bytes(b.b) : "—",
        city.final.t[i] > 0 ? new Date(city.final.t[i] * 1000).toISOString().slice(0, 10) : "—",
      ];
      for (const value of cells) {
        const cell = document.createElement("span");
        cell.textContent = value;
        row.append(cell);
      }
      row.addEventListener("click", () => cb.onFocusBuilding(i));
      exRows.append(row);
    }

    const more = el<HTMLButtonElement>("ex-more");
    more.hidden = rows.length <= shown;
    more.textContent = `SHOW ${n(Math.min(EXPLORER_PAGE * 4, rows.length - shown))} MORE`;
  }

  for (const node of [exQuery, exLanguage, exDistrict, exSort]) {
    node.addEventListener("input", () => {
      shown = EXPLORER_PAGE;
      renderExplorer();
    });
  }
  el("ex-more").addEventListener("click", () => {
    shown += EXPLORER_PAGE * 4;
    renderExplorer();
  });

  return {
    mount(next) {
      data = next;
      finalLines = Int32Array.from(next.final.h);

      for (const select of [exLanguage, el<HTMLSelectElement>("ex-district")]) {
        select.textContent = "";
      }
      const used = new Set(next.buildings.map((b) => next.languages[b.l]));
      const anyLanguage = document.createElement("option");
      anyLanguage.value = "";
      anyLanguage.textContent = "ANY LANGUAGE";
      exLanguage.append(anyLanguage);
      for (const language of [...used].sort()) {
        const option = document.createElement("option");
        option.value = language;
        option.textContent = language.toUpperCase();
        exLanguage.append(option);
      }

      const anyDistrict = document.createElement("option");
      anyDistrict.value = "";
      anyDistrict.textContent = "ALL DISTRICTS";
      exDistrict.append(anyDistrict);
      next.districts
        .map((d, i) => ({ d, i }))
        .sort((a, b) => b.d.lots - a.d.lots)
        .forEach(({ d, i }) => {
          const option = document.createElement("option");
          option.value = String(i);
          option.textContent = d.path.toUpperCase();
          exDistrict.append(option);
        });

      shown = EXPLORER_PAGE;
      renderArchitecture();
      renderEvolution();
      renderCoverage();
      renderExplorer();
    },

    setFrame(frame) {
      if (!data) return;
      const f = data.frames[Math.min(data.frames.length - 1, Math.max(0, frame))];
      el("evo-now").textContent = `${f.date} · ${n(f.buildings)} buildings · ${compact(f.lines)} LOC`;
    },
  };
}
