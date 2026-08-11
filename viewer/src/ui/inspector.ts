import type { CityData } from "../../../ingest/types.js";
import { bytes, compact, n } from "../util/format.js";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export interface InspectorTarget {
  index: number;
  lines: number;
  touch: number;
}

export interface Inspector {
  show(data: CityData, target: InspectorTarget): void;
  hide(): void;
  update(data: CityData, target: InspectorTarget): void;
  isOpen(): boolean;
}

export function createInspector(onClose: () => void): Inspector {
  const root = el("inspect");
  const title = el("inspect-name");
  const path = el("inspect-path");
  const kind = el("inspect-kind");
  const loc = el("inspect-loc");
  const size = el("inspect-size");
  const touched = el("inspect-touched");
  const district = el("inspect-district");

  el("inspect-close").addEventListener("click", () => onClose());

  let open = false;

  function paint(data: CityData, target: InspectorTarget): void {
    const b = data.buildings[target.index];
    title.textContent = b.n;
    path.textContent = b.p || "/";
    kind.textContent = b.a > 0 ? `AGGREGATE · ${n(b.a)} FILES` : "FILE";
    loc.textContent = target.lines > 0 ? n(target.lines) : "—";
    size.textContent = b.b > 0 ? bytes(b.b) : "—";
    touched.textContent = target.touch > 0
      ? new Date(target.touch * 1000).toISOString().slice(0, 10)
      : "NOT YET CREATED";
    district.textContent = (data.districts[b.d].name === "/" ? "ROOT" : data.districts[b.d].name).toUpperCase();
    void compact;
  }

  return {
    show(data, target) {
      paint(data, target);
      open = true;
      root.hidden = false;
      requestAnimationFrame(() => root.classList.add("is-open"));
    },
    update(data, target) {
      if (!open) return;
      paint(data, target);
    },
    hide() {
      open = false;
      root.classList.remove("is-open");
      window.setTimeout(() => {
        if (!open) root.hidden = true;
      }, 220);
    },
    isOpen: () => open,
  };
}
