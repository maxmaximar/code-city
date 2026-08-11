import type { CityData } from "../../../ingest/types.js";
import { compact, n } from "../util/format.js";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export interface SearchHit {
  kind: "file" | "district";
  index: number;
  label: string;
  detail: string;
  metric: string;
}

export interface SearchCallbacks {
  onPick(hit: SearchHit): void;
  onIsolate(district: number): void;
}

export interface SearchPanel {
  mount(data: CityData, lines: Int32Array): void;
  /** re-rank against the current frame's line counts */
  refresh(lines: Int32Array): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  query(text: string): SearchHit[];
}

const MAX_RESULTS = 40;

export function createSearch(cb: SearchCallbacks): SearchPanel {
  const root = el("search");
  const input = el<HTMLInputElement>("search-input");
  const results = el("search-results");
  const isolateBtn = el<HTMLButtonElement>("search-isolate");
  const languageSelect = el<HTMLSelectElement>("search-language");
  const districtSelect = el<HTMLSelectElement>("search-district");

  let data: CityData | null = null;
  let lines: Int32Array = new Int32Array(0);
  /** lowercase paths, built once — 22k `toLowerCase()` per keystroke is not free */
  let lowerPaths: string[] = [];
  let lowerNames: string[] = [];
  let standingByDistrict: number[] = [];
  let active = -1;
  let current: SearchHit[] = [];
  let isolated = -1;

  function scoreOf(index: number, needle: string): number {
    const name = lowerNames[index];
    const path = lowerPaths[index];
    if (name === needle) return 1000;
    if (name.startsWith(needle)) return 800;
    if (name.includes(needle)) return 600;
    const at = path.indexOf(needle);
    if (at === -1) return -1;
    // a match right after a slash is a folder-name match — worth more
    return at === 0 || path[at - 1] === "/" ? 420 : 260;
  }

  function query(text: string): SearchHit[] {
    if (!data) return [];
    const needle = text.trim().toLowerCase();
    if (needle.length === 0) return [];

    const language = languageSelect.value;
    const district = districtSelect.value === "" ? -1 : Number(districtSelect.value);

    const hits: Array<{ hit: SearchHit; rank: number }> = [];

    data.districts.forEach((d, i) => {
      const label = d.path.toLowerCase();
      if (!label.includes(needle)) return;
      if (district >= 0 && district !== i) return;
      hits.push({
        hit: {
          kind: "district",
          index: i,
          label: d.path,
          detail: `${n(d.lots)} lots · ${n(standingByDistrict[i])} standing`,
          metric: compact(d.lines),
        },
        rank: 1500 + d.lots,
      });
    });

    for (let i = 0; i < lowerPaths.length; i++) {
      const b = data.buildings[i];
      if (district >= 0 && b.d !== district) continue;
      if (language && data.languages[b.l] !== language) continue;
      const score = scoreOf(i, needle);
      if (score < 0) continue;
      // standing buildings and larger files outrank ghosts and stubs
      hits.push({
        hit: {
          kind: "file",
          index: i,
          label: b.n,
          detail: b.p,
          metric: lines[i] > 0 ? `${n(lines[i])} LOC` : "not present",
        },
        rank: score + (lines[i] > 0 ? 120 : 0) + Math.min(100, Math.log2(1 + lines[i]) * 8),
      });
      if (hits.length > 4000) break;
    }

    hits.sort((a, b) => b.rank - a.rank);
    return hits.slice(0, MAX_RESULTS).map((h) => h.hit);
  }

  function render(): void {
    results.textContent = "";
    if (current.length === 0) {
      results.hidden = true;
      return;
    }
    results.hidden = false;

    current.forEach((hit, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `hit${i === active ? " is-active" : ""}${hit.kind === "district" ? " hit--district" : ""}`;

      const label = document.createElement("b");
      label.textContent = hit.label;
      const detail = document.createElement("i");
      detail.textContent = hit.detail;
      const metric = document.createElement("s");
      metric.textContent = hit.metric;

      row.append(label, detail, metric);
      row.addEventListener("click", () => {
        cb.onPick(hit);
        close();
      });
      results.append(row);
    });
  }

  function run(): void {
    current = query(input.value);
    active = current.length > 0 ? 0 : -1;
    render();
  }

  function close(): void {
    root.classList.remove("is-open");
    results.hidden = true;
    input.blur();
  }

  input.addEventListener("input", run);
  input.addEventListener("focus", () => {
    root.classList.add("is-open");
    if (input.value) run();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      input.value = "";
      close();
      return;
    }
    if (current.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : current.length - 1)) % current.length;
      render();
      results.children[active]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      cb.onPick(current[active]);
      close();
    }
  });

  languageSelect.addEventListener("change", run);
  districtSelect.addEventListener("change", () => {
    run();
    if (isolated >= 0) {
      isolated = districtSelect.value === "" ? -1 : Number(districtSelect.value);
      cb.onIsolate(isolated);
      isolateBtn.classList.toggle("is-on", isolated >= 0);
    }
  });

  isolateBtn.addEventListener("click", () => {
    const wanted = districtSelect.value === "" ? -1 : Number(districtSelect.value);
    isolated = isolated >= 0 ? -1 : wanted;
    if (isolated < 0 && wanted < 0) {
      districtSelect.focus();
      return;
    }
    cb.onIsolate(isolated);
    isolateBtn.classList.toggle("is-on", isolated >= 0);
  });

  return {
    mount(next, nextLines) {
      data = next;
      lines = nextLines;
      lowerPaths = next.buildings.map((b) => b.p.toLowerCase());
      lowerNames = next.buildings.map((b) => b.n.toLowerCase());
      standingByDistrict = next.districts.map(() => 0);
      next.buildings.forEach((b, i) => {
        if (next.final.h[i] > 0) standingByDistrict[b.d]++;
      });
      input.value = "";
      current = [];
      isolated = -1;
      isolateBtn.classList.remove("is-on");
      results.hidden = true;

      const used = new Set(next.buildings.map((b) => next.languages[b.l]));
      languageSelect.textContent = "";
      const anyLanguage = document.createElement("option");
      anyLanguage.value = "";
      anyLanguage.textContent = "ANY LANGUAGE";
      languageSelect.append(anyLanguage);
      for (const language of [...used].sort()) {
        const option = document.createElement("option");
        option.value = language;
        option.textContent = language.toUpperCase();
        languageSelect.append(option);
      }

      districtSelect.textContent = "";
      const anyDistrict = document.createElement("option");
      anyDistrict.value = "";
      anyDistrict.textContent = "ALL DISTRICTS";
      districtSelect.append(anyDistrict);
      next.districts
        .map((d, i) => ({ d, i }))
        .sort((a, b) => b.d.lots - a.d.lots)
        .forEach(({ d, i }) => {
          const option = document.createElement("option");
          option.value = String(i);
          option.textContent = d.path.toUpperCase();
          districtSelect.append(option);
        });
    },

    refresh(nextLines) {
      lines = nextLines;
    },

    open() {
      root.classList.add("is-open");
      input.focus();
      input.select();
    },

    close,
    isOpen: () => root.classList.contains("is-open"),
    query,
  };
}
