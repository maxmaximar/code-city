import * as THREE from "three";
import type { CityData } from "../../../ingest/types.js";
import { buildingMaterial, rampColorCached, type CityUniforms } from "./materials.js";
import { createArchetypeKit, hashPath } from "./archetypes.js";
import { buildInfrastructure } from "./infrastructure.js";

/** footprint range for a single file, as a fraction of a lot */
const FOOT_MIN = 0.72;
const FOOT_MAX = 0.97;
/** aggregates read as whole city blocks, so they sit wider */
const FOOT_AGG_MIN = 0.86;
const FOOT_AGG_MAX = 0.99;

/**
 * World height a median building reaches. The ceiling is deliberately close to
 * it: a tower is roughly 20 lots tall at most, which is already a slender
 * skyscraper next to a one-lot footprint. Pushing it higher produces needles,
 * not architecture.
 */
const H_TYPICAL = 2.2;
/** ceiling, fitted to the 99th percentile */
const H_MAX = 20;
const H_MIN = 0.6;

/** how much of the colour comes from calendar recency vs. rank among peers */
const ABS_MIX = 0.25;
const RECENCY_GAMMA = 1.15;

/** how fast a building's height chases its target when the frame changes */
const HEIGHT_LERP = 7.5;

export interface DistrictAnchor {
  name: string;
  point: THREE.Vector3;
  lines: number;
  lots: number;
  /** this district's share of the repository's lines, 0…1 */
  share: number;
}

export interface PickResult {
  index: number;
  distance: number;
}

export interface CityView {
  root: THREE.Group;
  anchors: DistrictAnchor[];
  bounds: THREE.Box3;
  uniforms: CityUniforms;
  visible: number;
  heights: Float32Array;
  applyState(
    lines: ArrayLike<number>,
    touch: ArrayLike<number>,
    immediate?: boolean,
    changed?: Int32Array | null,
  ): void;
  update(dt: number, elapsed: number): void;
  settled(): boolean;
  setFocus(index: number | null, kind: "hover" | "select"): void;
  pick(ray: THREE.Ray): PickResult | null;
  anchorOf(index: number, out: THREE.Vector3): THREE.Vector3;
  setBuild(progress: number): void;
  /** how instance colour is derived — height always stays lines of code */
  setColorMode(mode: ColorMode): void;
  colorMode(): ColorMode;
  /** dim everything outside one district, or -1 for the whole city */
  setIsolation(district: number): void;
  /** world point and framing radius for a fly-to */
  focusOfBuilding(index: number): { point: THREE.Vector3; radius: number };
  focusOfDistrict(index: number): { point: THREE.Vector3; radius: number };
  dispose(): void;
}

export type ColorMode = "recency" | "language";

/** Deterministic, well-separated hues for the language view. */
export function languageColor(index: number, total: number): THREE.Color {
  if (index <= 0) return new THREE.Color(0x5b6b74);
  // golden-angle walk keeps neighbouring languages visually distinct
  const hue = ((index * 0.61803398875) % 1 + 0.02) % 1;
  return new THREE.Color().setHSL(hue, 0.62, 0.55 - 0.06 * ((index % 3) / 3) + 0.0 * total);
}

function quantiles(values: ArrayLike<number>, ps: number[]): number[] {
  const sorted: number[] = [];
  for (let i = 0; i < values.length; i++) if (values[i] > 0) sorted.push(values[i]);
  if (sorted.length === 0) return ps.map(() => 1);
  sorted.sort((a, b) => a - b);
  return ps.map((p) => sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))]);
}

/**
 * A fixed lines→height curve does not survive contact with real repos: one of
 * 30-line modules and one of 3000-line generated baselines need different
 * scales, or one renders flat and the other is a wall of clipped towers. The
 * curve is fitted per repo — median at H_TYPICAL, 99th percentile at H_MAX.
 */
export function makeHeightScale(lines: ArrayLike<number>): (n: number) => number {
  const [p50raw, p99raw] = quantiles(lines, [0.5, 0.99]);
  const p50 = Math.max(1, p50raw);
  const p99 = Math.max(p50 * 2, p99raw);
  const exponent = Math.min(1, Math.max(0.2, Math.log(H_MAX / H_TYPICAL) / Math.log(p99 / p50)));
  return (n) =>
    n <= 0 ? 0 : Math.max(H_MIN, Math.min(H_MAX, H_TYPICAL * Math.pow(n / p50, exponent)));
}

export function buildCity(data: CityData, uniforms: CityUniforms): CityView {
  const root = new THREE.Group();
  const disposables: Array<{ dispose(): void }> = [];
  const count = data.buildings.length;

  const infrastructure = buildInfrastructure(data, uniforms);
  root.add(infrastructure.group);
  disposables.push(infrastructure);

  // ── footprints, from blob size ───────────────────────────────────────────
  // Independent of height on purpose: LOC drives how tall a building is, bytes
  // on disk drive how wide, so a big file is a tower and not a needle.
  const byteRank = (() => {
    const sorted: number[] = [];
    for (const b of data.buildings) if (b.b > 0) sorted.push(b.b);
    sorted.sort((x, y) => x - y);
    return (v: number): number => {
      if (sorted.length < 2 || v <= 0) return 0;
      let lo = 0;
      let hi = sorted.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < v) lo = mid + 1;
        else hi = mid;
      }
      return lo / (sorted.length - 1);
    };
  })();

  // ── batch assignment ─────────────────────────────────────────────────────
  const kit = createArchetypeKit();
  disposables.push(kit);

  const heightScale = makeHeightScale(data.final.h);
  const hashes = new Uint32Array(count);
  const batchOf = new Int32Array(count);
  const slotOf = new Int32Array(count);
  const perBatch = new Array<number>(kit.geometries.length).fill(0);

  data.buildings.forEach((b, i) => {
    hashes[i] = hashPath(b.p);
    // The archetype is chosen from the building's *final* height, not the
    // frame's, so replaying history rescales a building instead of morphing it
    // into a different piece of architecture.
    batchOf[i] = kit.pick(hashes[i], heightScale(data.final.h[i]));
    perBatch[batchOf[i]]++;
  });

  const material = buildingMaterial(uniforms);
  disposables.push(material);

  const meshes: THREE.InstancedMesh[] = [];
  const attrHeight: THREE.InstancedBufferAttribute[] = [];
  const attrFocus: THREE.InstancedBufferAttribute[] = [];

  kit.geometries.forEach((source, bi) => {
    const n = Math.max(1, perBatch[bi]);

    // One geometry per batch, sharing the kit's vertex buffers. Assigning
    // `geometry.attributes` wholesale would alias the container and every batch
    // would overwrite the previous batch's instance data.
    const geo = new THREE.InstancedBufferGeometry();
    for (const name of ["position", "normal", "aTrim", "aEdge", "aVolume"]) {
      geo.setAttribute(name, source.getAttribute(name));
    }
    geo.instanceCount = n;

    const height = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    height.setUsage(THREE.DynamicDrawUsage);
    const seed = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    const delay = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    const focus = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    focus.setUsage(THREE.DynamicDrawUsage);

    const district = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);

    geo.setAttribute("aHeight", height);
    geo.setAttribute("aSeed", seed);
    geo.setAttribute("aDelay", delay);
    geo.setAttribute("aFocus", focus);
    geo.setAttribute("aDistrict", district);

    const mesh = new THREE.InstancedMesh(geo, material, n);
    mesh.frustumCulled = false;
    mesh.count = perBatch[bi];
    root.add(mesh);

    meshes.push(mesh);
    attrHeight.push(height);
    attrFocus.push(focus);
    disposables.push(geo, mesh);
  });

  // ── placement ────────────────────────────────────────────────────────────
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const d of data.districts) {
    minX = Math.min(minX, d.px);
    maxX = Math.max(maxX, d.px + d.pw);
    minZ = Math.min(minZ, d.pz);
    maxZ = Math.max(maxZ, d.pz + d.pd);
  }
  const centreX = (minX + maxX) / 2;
  const centreZ = (minZ + maxZ) / 2;
  const maxRadius = Math.hypot((maxX - minX) / 2, (maxZ - minZ) / 2) || 1;

  const worldX = new Float32Array(count);
  const worldZ = new Float32Array(count);
  const halfX = new Float32Array(count);
  const halfZ = new Float32Array(count);

  const cursor = new Array<number>(kit.geometries.length).fill(0);
  const m = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();

  data.buildings.forEach((b, i) => {
    const batch = batchOf[i];
    const slot = cursor[batch]++;
    slotOf[i] = slot;

    const h = hashes[i];
    const rank = byteRank(b.b);
    const base =
      b.a > 0
        ? FOOT_AGG_MIN + (FOOT_AGG_MAX - FOOT_AGG_MIN) * Math.pow(rank, 0.7)
        : FOOT_MIN + (FOOT_MAX - FOOT_MIN) * Math.pow(rank, 0.8);

    // a little deterministic width/depth variation, area preserved
    const aspect = 1 + (((h >>> 19) % 25) / 100 - 0.12);
    const fx = base * aspect;
    const fz = base / aspect;
    const turn = (h >>> 23) % 4;

    worldX[i] = b.x;
    worldZ[i] = b.z;
    halfX[i] = (turn % 2 === 0 ? fx : fz) / 2;
    halfZ[i] = (turn % 2 === 0 ? fz : fx) / 2;

    pos.set(b.x, infrastructure.padY, b.z);
    quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (turn * Math.PI) / 2);
    scl.set(fx, 1, fz);
    meshes[batch].setMatrixAt(slot, m.compose(pos, quat, scl));

    const geo = meshes[batch].geometry as THREE.InstancedBufferGeometry;
    const seedAttr = geo.getAttribute("aSeed") as THREE.InstancedBufferAttribute;
    const delayAttr = geo.getAttribute("aDelay") as THREE.InstancedBufferAttribute;
    (geo.getAttribute("aDistrict") as THREE.InstancedBufferAttribute).setX(slot, b.d);

    const seed = ((h >>> 8) % 10000) / 10000;
    seedAttr.setX(slot, seed);

    // the construction wave sweeps outward from the city core
    const radial = Math.hypot(b.x - centreX, b.z - centreZ) / maxRadius;
    delayAttr.setX(slot, Math.min(0.94, radial * 0.62 + seed * 0.16));
  });

  for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;

  // ── colour ───────────────────────────────────────────────────────────────
  const colourScratch = new THREE.Color();
  const languagePalette = data.languages.map((_, i) => languageColor(i, data.languages.length));
  let mode: ColorMode = "recency";
  let tsMin = 0;
  let tsMax = 1;
  let sortedTouch: number[] = [];
  let scaleStamp = -1e9;

  function recomputeRecencyScale(touch: ArrayLike<number>, lines: ArrayLike<number>): void {
    sortedTouch = [];
    for (let i = 0; i < count; i++) {
      if (lines[i] > 0 && touch[i] > 0) sortedTouch.push(touch[i]);
    }
    sortedTouch.sort((a, b) => a - b);
    tsMin = sortedTouch.length ? sortedTouch[0] : 0;
    tsMax = sortedTouch.length ? sortedTouch[sortedTouch.length - 1] : 1;
  }

  function recency(ts: number): number {
    if (ts <= 0 || sortedTouch.length === 0) return 0;
    let lo = 0;
    let hi = sortedTouch.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedTouch[mid] < ts) lo = mid + 1;
      else hi = mid;
    }
    const rank = sortedTouch.length > 1 ? lo / (sortedTouch.length - 1) : 1;
    const absolute = (ts - tsMin) / Math.max(1, tsMax - tsMin);
    const mixed = Math.min(1, Math.max(0, ABS_MIX * absolute + (1 - ABS_MIX) * rank));
    return Math.pow(mixed, RECENCY_GAMMA);
  }

  // ── state ────────────────────────────────────────────────────────────────
  const targetH = new Float32Array(count);
  const currentH = new Float32Array(count);
  const maxHeightPerDistrict = new Array<number>(data.districts.length).fill(0);
  let cityHeight = 1;
  let dirtyHeights = true;

  function flushHeights(): void {
    for (let i = 0; i < count; i++) attrHeight[batchOf[i]].setX(slotOf[i], currentH[i]);
    for (const attr of attrHeight) attr.needsUpdate = true;
  }

  let lastLines: ArrayLike<number> = data.final.h;
  let lastTouch: ArrayLike<number> = data.final.t;

  function applyState(
    lines: ArrayLike<number>,
    touch: ArrayLike<number>,
    immediate = false,
    changed: Int32Array | null = null,
  ): void {
    lastLines = lines;
    lastTouch = touch;
    // Re-ranking every building is an O(n log n) sort; at 4× playback the frame
    // advances far faster than the colour distribution meaningfully shifts, so
    // the scale is refreshed on a short interval rather than every frame.
    const now = performance.now();
    const rescaled = immediate || now - scaleStamp > 220;
    if (rescaled) {
      recomputeRecencyScale(touch, lines);
      scaleStamp = now;
    }

    const colourAll = mode !== "language" && rescaled;
    const indices = changed && !immediate && !colourAll ? changed : null;

    if (indices) {
      // partial update: only the buildings this frame actually moved
      for (const i of indices) {
        const h = heightScale(lines[i]);
        targetH[i] = h;
        colourScratch.copy(
          mode === "language" ? languagePalette[data.buildings[i].l] : rampColorCached(recency(touch[i])),
        );
        meshes[batchOf[i]].setColorAt(slotOf[i], colourScratch);
      }
    } else {
      maxHeightPerDistrict.fill(0);
      for (let i = 0; i < count; i++) {
        const h = heightScale(lines[i]);
        targetH[i] = h;
        if (immediate) currentH[i] = h;
        if (h > 0 && h > maxHeightPerDistrict[data.buildings[i].d]) {
          maxHeightPerDistrict[data.buildings[i].d] = h;
        }
        colourScratch.copy(
          mode === "language" ? languagePalette[data.buildings[i].l] : rampColorCached(recency(touch[i])),
        );
        meshes[batchOf[i]].setColorAt(slotOf[i], colourScratch);
      }
    }

    let standing = 0;
    let tallest = 0;
    for (let i = 0; i < count; i++) {
      if (targetH[i] > 0) {
        standing++;
        if (targetH[i] > tallest) tallest = targetH[i];
      }
    }

    view.visible = standing;
    cityHeight = Math.max(1, tallest);
    uniforms.uCityHeight.value = cityHeight;

    for (const mesh of meshes) {
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    if (immediate) flushHeights();
    updateAnchors();
    dirtyHeights = true;
  }

  // ── focus ────────────────────────────────────────────────────────────────
  const focusEasing = new Map<number, { value: number; target: number }>();
  let hovered: number | null = null;
  let selected: number | null = null;

  function refreshFocusTargets(): void {
    const wanted = new Map<number, number>();
    if (selected !== null) wanted.set(selected, 1);
    if (hovered !== null) wanted.set(hovered, Math.max(wanted.get(hovered) ?? 0, 0.72));

    for (const [index, entry] of focusEasing) entry.target = wanted.get(index) ?? 0;
    for (const [index, target] of wanted) {
      if (!focusEasing.has(index)) focusEasing.set(index, { value: 0, target });
    }
  }

  function setFocus(index: number | null, kind: "hover" | "select"): void {
    if (kind === "hover") hovered = index;
    else selected = index;
    refreshFocusTargets();
  }

  // ── update ───────────────────────────────────────────────────────────────
  function update(dt: number, elapsed: number): void {
    uniforms.uTime.value = elapsed;

    if (dirtyHeights) {
      const k = 1 - Math.exp(-HEIGHT_LERP * Math.min(dt, 0.1));
      let moving = false;
      for (let i = 0; i < count; i++) {
        const diff = targetH[i] - currentH[i];
        if (Math.abs(diff) < 0.002) {
          currentH[i] = targetH[i];
        } else {
          currentH[i] += diff * k;
          moving = true;
        }
      }
      flushHeights();
      dirtyHeights = moving;
    }

    if (focusEasing.size > 0) {
      const k = 1 - Math.exp(-14 * Math.min(dt, 0.1));
      for (const [index, entry] of focusEasing) {
        entry.value += (entry.target - entry.value) * k;
        attrFocus[batchOf[index]].setX(slotOf[index], entry.value);
        attrFocus[batchOf[index]].needsUpdate = true;
        if (Math.abs(entry.target - entry.value) < 0.004) {
          attrFocus[batchOf[index]].setX(slotOf[index], entry.target);
          if (entry.target === 0) focusEasing.delete(index);
          else entry.value = entry.target;
        }
      }
    }
  }

  // ── picking ──────────────────────────────────────────────────────────────
  // Height lives in a shader attribute and the archetypes are not boxes, so
  // three's instanced raycast cannot help. A slab test against each building's
  // real lot footprint and its eased height is exact enough and much cheaper.
  const blockBox = data.blocks.map(
    (b) => new THREE.Box3(new THREE.Vector3(b.x, 0, b.z), new THREE.Vector3(b.x + b.w, 1, b.z + b.h)),
  );
  const buildingsOfBlock: number[][] = data.blocks.map(() => []);
  data.buildings.forEach((b, i) => buildingsOfBlock[b.k].push(i));

  const blockCeiling = new Float32Array(data.blocks.length);

  function pick(ray: THREE.Ray): PickResult | null {
    blockCeiling.fill(0);
    for (let i = 0; i < count; i++) {
      const k = data.buildings[i].k;
      if (currentH[i] > blockCeiling[k]) blockCeiling[k] = currentH[i];
    }

    let best: PickResult | null = null;
    for (let k = 0; k < blockBox.length; k++) {
      blockBox[k].max.y = Math.max(0.5, blockCeiling[k] + 0.5);
      if (!ray.intersectsBox(blockBox[k])) continue;

      for (const i of buildingsOfBlock[k]) {
        const h = currentH[i];
        if (h <= 0.02) continue;

        let t0 = -Infinity;
        let t1 = Infinity;
        for (let axis = 0; axis < 3; axis++) {
          const o = axis === 0 ? ray.origin.x : axis === 1 ? ray.origin.y : ray.origin.z;
          const dir = axis === 0 ? ray.direction.x : axis === 1 ? ray.direction.y : ray.direction.z;
          const lo = axis === 0 ? worldX[i] - halfX[i] : axis === 1 ? 0 : worldZ[i] - halfZ[i];
          const hi = axis === 0 ? worldX[i] + halfX[i] : axis === 1 ? h : worldZ[i] + halfZ[i];
          if (Math.abs(dir) < 1e-8) {
            if (o < lo || o > hi) {
              t0 = Infinity;
              break;
            }
            continue;
          }
          const a = (lo - o) / dir;
          const b = (hi - o) / dir;
          t0 = Math.max(t0, Math.min(a, b));
          t1 = Math.min(t1, Math.max(a, b));
        }
        if (t0 > t1 || t1 < 0) continue;
        const distance = t0 >= 0 ? t0 : t1;
        if (!best || distance < best.distance) best = { index: i, distance };
      }
    }
    return best;
  }

  function anchorOf(index: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(worldX[index], currentH[index], worldZ[index]);
  }

  // ── labels ───────────────────────────────────────────────────────────────
  const totalLines = data.districts.reduce((s, d) => s + d.lines, 0) || 1;
  const anchors: DistrictAnchor[] = data.districts.map((d) => ({
    name: (d.name === "/" ? "ROOT" : d.name.replace(/^·/, "")).toUpperCase(),
    point: new THREE.Vector3(d.px + d.pw / 2, 5, d.pz + d.pd / 2),
    lines: d.lines,
    lots: d.lots,
    share: d.lines / totalLines,
  }));

  function updateAnchors(): void {
    // well clear of the tallest tower: a label sitting inside the skyline is
    // unreadable no matter how much text-shadow it gets
    anchors.forEach((anchor, i) => {
      anchor.point.y = Math.max(maxHeightPerDistrict[i] + 9, 8);
    });
  }

  const bounds = new THREE.Box3(
    new THREE.Vector3(minX, 0, minZ),
    new THREE.Vector3(maxX, 12, maxZ),
  );

  const view: CityView = {
    root,
    anchors,
    bounds,
    uniforms,
    visible: 0,
    heights: currentH,
    applyState,
    update,
    settled: () => !dirtyHeights,
    setFocus,
    pick,
    anchorOf,
    setBuild(progress) {
      uniforms.uBuild.value = progress;
    },

    setColorMode(next) {
      if (next === mode) return;
      mode = next;
      applyState(lastLines, lastTouch, true);
    },

    colorMode: () => mode,

    setIsolation(district) {
      uniforms.uIsolate.value = district;
    },

    focusOfBuilding(index) {
      return {
        point: new THREE.Vector3(worldX[index], Math.max(1.5, currentH[index] * 0.55), worldZ[index]),
        radius: Math.max(4, currentH[index] * 0.9),
      };
    },

    focusOfDistrict(index) {
      const d = data.districts[index];
      return {
        point: new THREE.Vector3(
          d.px + d.pw / 2,
          Math.max(2, maxHeightPerDistrict[index] * 0.4),
          d.pz + d.pd / 2,
        ),
        radius: Math.max(8, Math.hypot(d.pw, d.pd) * 0.42),
      };
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };

  applyState(data.final.h, data.final.t, true);
  bounds.max.y = Math.max(6, cityHeight);

  return view;
}
