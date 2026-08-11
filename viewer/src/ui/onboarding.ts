import type { Manifest, Progress } from "../net/api.js";
import { ago, n } from "../util/format.js";

export const STAGES = [
  "CLONING",
  "ANALYZING FILES",
  "PARSING HISTORY",
  "BUILDING CITY",
  "CITY READY",
] as const;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export interface OnboardingCallbacks {
  onAnalyze(url: string): void;
  onOpen(slug: string): void;
  /** an entry written by an older layout — rebuild it from the cached clone */
  onRebuild(repoUrl: string): void;
}

export interface Onboarding {
  show(closable: boolean): void;
  hide(): void;
  isOpen(): boolean;
  setRecent(manifest: Manifest): void;
  setBusy(url: string): void;
  setProgress(p: Progress): void;
  setError(message: string, action?: { label: string; run: () => void } | null): void;
  finish(): void;
}

export function createOnboarding(cb: OnboardingCallbacks): Onboarding {
  const root = el("onboard");
  const form = el<HTMLFormElement>("onboard-form");
  const input = el<HTMLInputElement>("onboard-url");
  const submit = el<HTMLButtonElement>("onboard-submit");
  const stageList = el("onboard-stages");
  const errorNode = el("onboard-error");
  const recent = el("onboard-recent");
  const bar = el("onboard-bar");
  const closeBtn = el<HTMLButtonElement>("onboard-close");

  const rows = new Map<string, { li: HTMLLIElement; detail: HTMLElement }>();

  for (const stage of STAGES) {
    const li = document.createElement("li");
    const dot = document.createElement("i");
    dot.className = "stage__dot";
    const label = document.createElement("span");
    label.className = "stage__label";
    label.textContent = stage;
    const detail = document.createElement("em");
    detail.className = "stage__detail";
    li.append(dot, label, detail);
    stageList.append(li);
    rows.set(stage, { li, detail });
  }

  let open = false;
  let busy = false;

  function resetStages(): void {
    for (const { li, detail } of rows.values()) {
      li.className = "";
      detail.textContent = "";
    }
    bar.style.width = "0%";
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url || busy) return;
    errorNode.textContent = "";
    cb.onAnalyze(url);
  });

  closeBtn.addEventListener("click", () => {
    if (!busy) api.hide();
  });

  root.addEventListener("pointerdown", (e) => {
    if (e.target === root && !busy && closeBtn.hidden === false) api.hide();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open && !busy && !closeBtn.hidden) api.hide();
  });

  const api: Onboarding = {
    show(closable) {
      open = true;
      root.hidden = false;
      root.classList.add("is-open");
      closeBtn.hidden = !closable;
      if (!busy) {
        resetStages();
        window.setTimeout(() => input.focus(), 120);
      }
    },

    hide() {
      open = false;
      root.classList.remove("is-open");
      window.setTimeout(() => {
        if (!open) root.hidden = true;
      }, 240);
    },

    isOpen: () => open,

    setRecent(manifest) {
      recent.textContent = "";
      if (!manifest.repos?.length) {
        recent.hidden = true;
        return;
      }
      recent.hidden = false;

      const title = document.createElement("h3");
      title.textContent = "ALREADY ANALYZED";
      recent.append(title);

      for (const entry of manifest.repos.slice(0, 8)) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = `recent__item${entry.stale ? " is-stale" : ""}`;

        const name = document.createElement("span");
        name.className = "recent__name";
        name.textContent = entry.repoName;

        const meta = document.createElement("span");
        meta.className = "recent__meta";
        meta.textContent = entry.missing
          ? "no longer on disk — select to analyze again"
          : entry.stale
            ? "built by an older version — select to rebuild"
            : `${n(entry.standing)} buildings · ${n(entry.commits)} commits · ${ago(entry.generatedAt)}`;

        item.append(name, meta);
        item.addEventListener("click", () => {
          if (entry.stale) cb.onRebuild(entry.repoUrl);
          else cb.onOpen(entry.slug);
        });
        recent.append(item);
      }
    },

    setBusy(url) {
      busy = true;
      input.value = url;
      input.disabled = true;
      submit.disabled = true;
      submit.textContent = "ANALYZING";
      closeBtn.hidden = true;
      errorNode.textContent = "";
      resetStages();
      root.classList.add("is-busy");
    },

    setProgress(p) {
      const index = STAGES.indexOf(p.stage as (typeof STAGES)[number]);
      STAGES.forEach((stage, i) => {
        const row = rows.get(stage);
        if (!row) return;
        row.li.className = i < index ? "is-done" : i === index ? "is-active" : "";
        if (i === index) row.detail.textContent = p.detail;
        else if (i > index) row.detail.textContent = "";
      });
      bar.style.width = `${(Math.min(1, Math.max(0, p.pct)) * 100).toFixed(1)}%`;
    },

    setError(message, action = null) {
      busy = false;
      input.disabled = false;
      submit.disabled = false;
      submit.textContent = "ANALYZE REPOSITORY";
      closeBtn.hidden = false;
      root.classList.remove("is-busy");

      errorNode.textContent = "";
      const text = document.createElement("span");
      text.textContent = message;
      errorNode.append(text);

      // A dead end is not an error state. When there is something the user can
      // do about it, the button to do it sits right here.
      if (action) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "btn";
        retry.textContent = action.label;
        retry.addEventListener("click", action.run);
        errorNode.append(retry);
      }

      for (const { li } of rows.values()) {
        if (li.className === "is-active") li.className = "is-error";
      }
    },

    finish() {
      busy = false;
      input.disabled = false;
      submit.disabled = false;
      submit.textContent = "ANALYZE REPOSITORY";
      root.classList.remove("is-busy");
      for (const stage of STAGES) {
        const row = rows.get(stage);
        if (row) row.li.className = "is-done";
      }
      bar.style.width = "100%";
    },
  };

  return api;
}
