import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "../style.css";

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

import type { CityData } from "../../ingest/types.js";
import { buildCity, type CityView } from "./scene/city.js";
import { createCityUniforms } from "./scene/materials.js";
import { createCameraRig } from "./scene/camera.js";
import { createReplay, type Replay } from "./data/replay.js";
import { compact } from "./util/format.js";
import { computeMetrics } from "./data/metrics.js";
import { analyze, CityLoadError, getCity, getManifest, type Manifest } from "./net/api.js";
import {
  renderMetaStrip,
  renderMetricsPanel,
  renderRepoPanel,
  renderStatusLine,
  renderStatusPanel,
  setNeedleRotation,
  setSessionState,
  setStatusMessage,
  setSyncState,
  setViewMode,
} from "./ui/hud.js";
import { createTimeline } from "./ui/timeline.js";
import { createOnboarding } from "./ui/onboarding.js";
import { createInspector } from "./ui/inspector.js";
import { createSearch, type SearchHit } from "./ui/search.js";
import { createSections } from "./ui/sections.js";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const sceneEl = document.getElementById("scene") as HTMLElement;
const labelLayer = document.getElementById("labels") as HTMLElement;

const LABEL_MIN_BUILDINGS = 24;
const LABEL_MAX = 10;
/** a full timeline run lasts this long at 1× */
const RUN_SECONDS = 20;
/**
 * A city that materialises in a blink is a loading spinner. Three and a half
 * seconds is long enough to actually watch a repository assemble itself, and
 * it only happens the first time — a cached city snaps back in half a second.
 */
const BUILD_MS_FRESH = 3400;
const BUILD_MS_CACHED = 550;

const params = new URLSearchParams(location.search);
/** screenshot mode: no drift, no build animation, deterministic frame */
const STILL = params.has("still");

// ── renderer ───────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// ACES rolls the hottest emissive off toward white instead of clipping to a
// flat block of colour, which is what makes the pulses read as white-hot.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;

const world = new THREE.Scene();
world.background = new THREE.Color(0x000000);

// One uniform block drives buildings, ground and conduits, which is what lets
// a single travelling pulse light the whole city coherently.
const uniforms = createCityUniforms();

const rig = createCameraRig(canvas);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(world, rig.camera));
// tight radius and a high threshold: bloom picks up scanlines, rims and pulses
// in each building's own hue, and leaves the dark cores alone
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.34, 0.82);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ── app state ──────────────────────────────────────────────────────────────
let data: CityData | null = null;
let replay: Replay | null = null;
let city: CityView | null = null;
let currentSlug = "";

let frame = 0;
let playing = false;
let speed = 1;
let flying = false;
let frameCursor = 0;

let buildStart = 0;
let buildDuration = 0;
let buildProgress = 1;

let hovered: number | null = null;
let selected: number | null = null;

let labelNodes: Array<{ node: HTMLElement; anchor: CityView["anchors"][number]; w: number }> = [];

const inspector = createInspector(() => {
  selected = null;
  city?.setFocus(null, "select");
  inspector.hide();
});

const search = createSearch({
  onPick(hit: SearchHit) {
    if (!city || !data) return;
    if (hit.kind === "district") {
      const focus = city.focusOfDistrict(hit.index);
      rig.flyTo(focus.point, focus.radius);
      setViewMode("ORBIT");
      return;
    }
    focusBuilding(hit.index, true);
  },
  onIsolate(district) {
    city?.setIsolation(district);
  },
});

const sections = createSections({
  onFocusDistrict(index) {
    scrollToCity();
    if (!city) return;
    const focus = city.focusOfDistrict(index);
    rig.flyTo(focus.point, focus.radius);
  },
  onFocusBuilding(index) {
    scrollToCity();
    focusBuilding(index, true);
  },
  onSeek(frame) {
    scrollToCity();
    stopPlayback();
    setFrame(frame);
  },
  snapshotAt(frameIndex) {
    if (!replay) return new Int32Array(0);
    replay.seek(frameIndex);
    const copy = Int32Array.from(replay.lines);
    replay.seek(frame);
    return copy;
  },
});

function scrollToCity(): void {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/** select a building, open its inspector, and optionally fly the camera to it */
function focusBuilding(index: number, fly: boolean): void {
  if (!city || !data || !replay) return;
  selected = index;
  city.setFocus(index, "select");
  inspector.show(data, { index, lines: replay.lines[index], touch: replay.touch[index] });
  if (fly) {
    const focus = city.focusOfBuilding(index);
    rig.flyTo(focus.point, focus.radius);
  }
}

const timeline = createTimeline({
  onSeek(next, live) {
    stopPlayback();
    if (!live) rig.returnHome();
    setFrame(next);
  },
  onTogglePlay() {
    if (playing) stopPlayback();
    else startPlayback(false);
  },
  onStep(delta) {
    stopPlayback();
    setFrame(frame + delta);
  },
  onSpeed(next) {
    speed = next;
    timeline.setSpeed(next);
  },
  onFlythrough() {
    if (flying) {
      stopPlayback();
      rig.returnHome();
    } else {
      setFrame(0);
      startPlayback(true);
    }
  },
});

const onboarding = createOnboarding({
  onAnalyze(url) {
    runAnalyze(url, {});
  },
  onOpen(slug) {
    onboarding.hide();
    void openCity(slug, { cached: true }).catch(reportLoadFailure);
  },
  onRebuild(repoUrl) {
    runAnalyze(repoUrl, { rebuild: true });
  },
});

/**
 * Anything that stops a city from loading ends up here: the user sees what
 * happened and, when the dataset can be rebuilt from the cached clone, a button
 * that does it. The technical detail still goes to the console.
 */
function reportLoadFailure(err: unknown): void {
  const known = err instanceof CityLoadError ? err : null;
  const message = err instanceof Error ? err.message : String(err);
  console.error("[codecity] failed to load city", err);

  setSessionState("ERROR", false);
  setStatusMessage(message);
  setSyncState("STALE");

  onboarding.show(Boolean(data));
  onboarding.setError(
    message,
    known?.recoverable && known.repoUrl
      ? { label: "REBUILD THIS CITY", run: () => runAnalyze(known.repoUrl!, { rebuild: true }) }
      : null,
  );
}

// ── loading ────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  timeline.setSpeed(speed);
  let manifest: Manifest = { default: null, repos: [] };
  try {
    manifest = await getManifest();
  } catch {
    setStatusMessage("local analyzer unreachable — run: bun run dev");
  }
  onboarding.setRecent(manifest);

  // `?fresh=1` means "show me the front door", not "open whatever was last used"
  const wanted = params.has("fresh") ? null : (params.get("repo") ?? manifest.default);
  if (!wanted) {
    setSessionState("NO CITY", false);
    setStatusMessage("paste a public repository url to begin");
    onboarding.show(false);
    return;
  }

  const entry = manifest.repos.find((r) => r.slug === wanted);
  try {
    await openCity(wanted, { cached: true, repoUrl: entry?.repoUrl });
  } catch (err) {
    reportLoadFailure(err);
  }
}

async function openCity(slug: string, opts: { cached: boolean; repoUrl?: string }): Promise<void> {
  setSessionState("LOADING", true);
  const next = await getCity(slug, opts.repoUrl ?? null);
  mountCity(next, slug, opts.cached ? BUILD_MS_CACHED : BUILD_MS_FRESH);
}

function mountCity(next: CityData, slug: string, buildMs: number): void {
  data = next;
  currentSlug = slug;

  if (city) {
    world.remove(city.root);
    city.dispose();
    city = null;
  }
  labelLayer.textContent = "";

  replay = createReplay(next);
  city = buildCity(next, uniforms);
  world.add(city.root);

  // Fog scales with the framing distance: it squares density × depth, so a
  // fixed value either does nothing on a small repo or swallows a large one.
  rig.frame(city.bounds);
  const viewDistance = rig.camera.position.distanceTo(rig.controls.target);
  uniforms.uFogDensity.value = 0.4 / viewDistance;
  uniforms.uFloor.value = Math.max(0.5, Math.min(1.4, city.bounds.max.y / 22));
  uniforms.uMullion.value = 0.085;
  // LOD bands scale with the city: on a 750-unit metropolis "far" has to mean
  // something different than it does on a village.
  uniforms.uLodNear.value = Math.max(60, viewDistance * 0.28);
  uniforms.uLodFar.value = Math.max(180, viewDistance * 0.95);

  const size = new THREE.Vector3();
  city.bounds.getSize(size);
  cityRadius = Math.max(8, Math.hypot(size.x, size.z) / 2);
  city.bounds.getCenter(waveHome);
  uniforms.uWaveWidth.value = Math.max(6, cityRadius * 0.16);
  uniforms.uScanSpan.value = cityRadius * 1.25;
  waveClock = 0;
  pickWaveOrigin(0);

  buildLabels(next);
  search.mount(next, replay.lines);
  sections.mount(next);
  const footer = document.getElementById("footer-repo");
  if (footer) footer.textContent = next.meta.repoName;
  renderRepoPanel(next);
  renderStatusPanel(next);
  renderMetaStrip(next);
  timeline.mount(next);

  frame = next.frames.length - 1;
  frameCursor = frame;
  applyFrame(true);

  selected = null;
  hovered = null;
  inspector.hide();

  document.title = `CODE CITY · ${next.meta.repoName}`;
  history.replaceState(null, "", `?repo=${encodeURIComponent(slug)}${STILL ? "&still=1" : ""}`);

  if (STILL) {
    buildProgress = 1;
    buildDuration = 0;
    city.setBuild(1);
    rig.setDrift(false);
  } else {
    uniforms.uWaveOrigin.value.set(waveHome.x, waveHome.z);
    buildProgress = 0;
    buildDuration = buildMs;
    buildStart = performance.now();
    city.setBuild(0);
    rig.setDrift(true);
  }

  setSessionState("READY", false);
}

function runAnalyze(url: string, options: { resync?: boolean; force?: boolean; rebuild?: boolean }): void {
  onboarding.setBusy(url);
  setSessionState(options.resync ? "SYNCING" : "ANALYZING", true);
  setSyncState("SYNCING");

  analyze(url, options, {
    onProgress(p) {
      onboarding.setProgress(p);
      setStatusMessage(`${p.stage.toLowerCase()} — ${p.detail}`);
    },
    onDone(result) {
      onboarding.finish();
      window.setTimeout(() => onboarding.hide(), 260);
      void (async () => {
        try {
          const next = await getCity(result.slug, url);
          mountCity(next, result.slug, result.fromCache ? BUILD_MS_CACHED : BUILD_MS_FRESH);
          setSyncState(result.fromCache ? "CACHED" : "SYNCED");
          onboarding.setRecent(await getManifest());
        } catch (err) {
          reportLoadFailure(err);
        }
      })();
    },
    onError(message) {
      console.error("[codecity] analyze failed", message);
      onboarding.setError(message, { label: "TRY AGAIN", run: () => runAnalyze(url, options) });
      setSessionState("ERROR", false);
      setSyncState("STALE");
      setStatusMessage(message);
    },
  });
}

// ── city-wide energy pulse ─────────────────────────────────────────────────
// A single expanding ring shared by every material. It costs three uniforms and
// no geometry, and it is what makes the districts read as one powered system
// rather than a thousand independently blinking objects.
const WAVE_SWEEP = 5.5;
const WAVE_REST = 4.5;

let cityRadius = 40;
let waveClock = 0;
let waveIndex = 0;
const waveHome = new THREE.Vector3();

function pickWaveOrigin(index: number): void {
  if (!data || data.districts.length === 0) {
    uniforms.uWaveOrigin.value.set(waveHome.x, waveHome.z);
    return;
  }
  // walk the districts by size so the pulse starts somewhere meaningful
  const d = data.districts[index % data.districts.length];
  uniforms.uWaveOrigin.value.set(d.px + d.pw / 2, d.pz + d.pd / 2);
}

function updateWave(dt: number): void {
  waveClock += dt;
  const cycle = WAVE_SWEEP + WAVE_REST;
  if (waveClock > cycle) {
    waveClock -= cycle;
    waveIndex++;
    pickWaveOrigin(waveIndex);
  }
  const t = waveClock / WAVE_SWEEP;
  uniforms.uWaveRadius.value =
    t <= 1 ? t * cityRadius * 2.1 : -1e4; // parked far away between sweeps
}

// ── frame plumbing ─────────────────────────────────────────────────────────

function setFrame(next: number, immediate = false): void {
  if (!data || !replay || !city) return;
  const clamped = Math.min(data.frames.length - 1, Math.max(0, Math.round(next)));
  if (clamped === frame && !immediate) return;
  frame = clamped;
  frameCursor = clamped;
  applyFrame(immediate);
}

function applyFrame(immediate: boolean): void {
  if (!data || !replay || !city) return;
  replay.seek(frame);
  city.applyState(replay.lines, replay.touch, immediate, replay.changed);

  timeline.setFrame(frame);
  sections.setFrame(frame);
  search.refresh(replay.lines);
  const fsFrame = document.getElementById("fs-frame");
  if (fsFrame) fsFrame.textContent = `${data.frames[frame].date} · ${frame + 1}/${data.frames.length}`;
  renderMetricsPanel(computeMetrics(data, replay, frame));
  renderStatusLine(frame + 1, data.frames.length, replay.standing, data.frames[frame].lines);

  if (selected !== null) {
    inspector.update(data, {
      index: selected,
      lines: replay.lines[selected],
      touch: replay.touch[selected],
    });
  }
}

function startPlayback(withCamera: boolean): void {
  if (!data) return;
  playing = true;
  flying = withCamera;
  if (frame >= data.frames.length - 1) setFrame(0, true);
  frameCursor = frame;
  timeline.setPlaying(true);
  timeline.setFlythrough(withCamera);
  rig.setDrift(!withCamera);
  if (withCamera) setViewMode("FLIGHT");
}

function stopPlayback(): void {
  playing = false;
  flying = false;
  timeline.setPlaying(false);
  timeline.setFlythrough(false);
  rig.setDrift(!STILL);
  setViewMode(rig.isTopView() ? "TOP" : "ORBIT");
}

// ── district labels ────────────────────────────────────────────────────────

function buildLabels(next: CityData): void {
  void next;
  if (!city) return;
  labelNodes = city.anchors
    .filter((anchor) => anchor.lots >= LABEL_MIN_BUILDINGS)
    .sort((a, b) => b.lines - a.lines)
    .slice(0, LABEL_MAX)
    .map((anchor) => {
      const node = document.createElement("span");
      const name = document.createElement("b");
      name.textContent = anchor.name;
      const meta = document.createElement("i");
      // real counts, straight off the district: files it owns and its share of
      // the repository's lines
      meta.textContent = `${compact(anchor.lots)} lots · ${Math.round(anchor.share * 100)}%`;
      node.append(name, meta);
      labelLayer.append(node);
      return { node, anchor, w: 0 };
    });
}

const projected = new THREE.Vector3();
const taken: Array<[number, number, number]> = [];

function updateLabels(width: number, height: number): void {
  taken.length = 0;
  for (const item of labelNodes) {
    const { node, anchor } = item;
    projected.copy(anchor.point).project(rig.camera);

    const x = (projected.x * 0.5 + 0.5) * width;
    const y = (-projected.y * 0.5 + 0.5) * height - 10;
    // measured lazily — offsetWidth is 0 until the label has been laid out, and
    // caching that zero would leave every label thinking it needs no clearance
    if (!item.w) item.w = node.offsetWidth;
    const half = (item.w || 96) / 2 + 12;

    // the compass owns the top-right, the search field the top-left, and the
    // mode switch the bottom-left — labels stay out of all three
    const inChrome =
      (x > width - 175 && y < 250) ||
      (x < 420 && y < 118) ||
      (x < 340 && y > height - 90);
    const offscreen =
      projected.z > 1 || x < -80 || x > width + 80 || y < -20 || y > height + 20 || inChrome;

    // two lines plus the leader line: they need real vertical clearance
    const collides =
      !offscreen &&
      taken.some(([tx, ty, tw]) => Math.abs(tx - x) < tw + half && Math.abs(ty - y) < 52);

    if (offscreen || collides) {
      node.style.visibility = "hidden";
      continue;
    }
    taken.push([x, y, half]);
    node.style.visibility = "visible";
    node.style.left = `${x.toFixed(1)}px`;
    node.style.top = `${y.toFixed(1)}px`;
  }
}

// ── picking ────────────────────────────────────────────────────────────────

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDirty = false;
let pointerInside = false;
let downAt: { x: number; y: number } | null = null;

canvas.addEventListener("pointermove", (e) => {
  const rect = canvas.getBoundingClientRect();
  pointer.set(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  pointerInside = true;
  pointerDirty = true;
});

canvas.addEventListener("pointerleave", () => {
  pointerInside = false;
  hovered = null;
  city?.setFocus(null, "hover");
  canvas.classList.remove("is-hit");
});

canvas.addEventListener("pointerdown", (e) => {
  downAt = { x: e.clientX, y: e.clientY };
});

canvas.addEventListener("pointerup", (e) => {
  if (!downAt || !data || !replay || !city) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 4) return;

  if (hovered === null) {
    selected = null;
    city.setFocus(null, "select");
    inspector.hide();
    return;
  }
  selected = hovered;
  city.setFocus(selected, "select");
  inspector.show(data, {
    index: selected,
    lines: replay.lines[selected],
    touch: replay.touch[selected],
  });
});

function updateHover(): void {
  if (!pointerDirty || !pointerInside || !city) return;
  pointerDirty = false;
  raycaster.setFromCamera(pointer, rig.camera);
  const hit = city.pick(raycaster.ray);
  const next = hit?.index ?? null;
  if (next === hovered) return;
  hovered = next;
  city.setFocus(next, "hover");
  canvas.classList.toggle("is-hit", next !== null);
}

// ── chrome wiring ──────────────────────────────────────────────────────────

document.getElementById("new-repo")?.addEventListener("click", () => onboarding.show(true));

document.getElementById("resync")?.addEventListener("click", () => {
  if (!data) {
    onboarding.show(true);
    return;
  }
  onboarding.show(true);
  runAnalyze(data.meta.repoUrl, { resync: true });
});

document.getElementById("top-view")?.addEventListener("click", (e) => {
  const button = e.currentTarget as HTMLButtonElement;
  const on = !rig.isTopView();
  rig.topView(on);
  button.classList.toggle("is-on", on);
  button.textContent = on ? "ORBIT VIEW" : "TOP VIEW";
  setViewMode(on ? "TOP" : "ORBIT");
});

// ── city fullscreen ────────────────────────────────────────────────────────
// Not the browser's fullscreen: the page chrome, the rail and the timeline all
// step aside so the 3D city owns the viewport, with only floating controls.
let fullscreen = false;

function setFullscreen(on: boolean): void {
  if (fullscreen === on) return;
  fullscreen = on;
  document.querySelector(".app")?.classList.toggle("is-fullscreen", on);
  document.body.style.overflow = on ? "hidden" : "";
  if (on) window.scrollTo({ top: 0 });
  requestAnimationFrame(() => resize());
}

document.getElementById("fullscreen")?.addEventListener("click", () => setFullscreen(true));
document.getElementById("fs-exit")?.addEventListener("click", () => setFullscreen(false));
document.getElementById("fs-search")?.addEventListener("click", () => search.open());
document.getElementById("fs-top")?.addEventListener("click", () => {
  const on = !rig.isTopView();
  rig.topView(on);
  setViewMode(on ? "TOP" : "ORBIT");
});

document.getElementById("native-fullscreen")?.addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen();
});

// ── view modes ─────────────────────────────────────────────────────────────
for (const button of document.querySelectorAll<HTMLButtonElement>("#modes button[data-color]")) {
  button.addEventListener("click", () => {
    const mode = button.dataset.color === "language" ? "language" : "recency";
    city?.setColorMode(mode);
    for (const other of document.querySelectorAll("#modes button[data-color]")) {
      other.classList.toggle("is-on", other === button);
    }
    const legend = document.querySelector<HTMLElement>(".legend");
    if (legend) legend.dataset.mode = mode;
  });
}

document.addEventListener("keydown", (e) => {
  if (onboarding.isOpen()) return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  if (e.key === "/") {
    e.preventDefault();
    search.open();
    return;
  }
  if (e.key === "Escape") {
    if (search.isOpen()) {
      search.close();
      return;
    }
    if (fullscreen) {
      setFullscreen(false);
      return;
    }
    if (city) {
      city.setIsolation(-1);
      selected = null;
      city.setFocus(null, "select");
      inspector.hide();
    }
    return;
  }

  if (e.code === "Space") {
    e.preventDefault();
    if (playing) stopPlayback();
    else startPlayback(false);
  } else if (e.key === "ArrowLeft") {
    // these all have a default the browser would rather use to scroll the page
    e.preventDefault();
    stopPlayback();
    setFrame(frame - (e.shiftKey ? 10 : 1));
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    stopPlayback();
    setFrame(frame + (e.shiftKey ? 10 : 1));
  } else if (e.key === "Home") {
    e.preventDefault();
    stopPlayback();
    setFrame(0);
  } else if (e.key === "End") {
    e.preventDefault();
    stopPlayback();
    setFrame(data ? data.frames.length - 1 : 0);
  } else if (e.key.toLowerCase() === "f") {
    if (flying) {
      stopPlayback();
      rig.returnHome();
    } else {
      setFrame(0, true);
      startPlayback(true);
    }
  }
});

// ── resize ─────────────────────────────────────────────────────────────────
let width = 1;
let height = 1;

function resize(): void {
  const rect = sceneEl.getBoundingClientRect();
  width = Math.max(1, Math.round(rect.width));
  height = Math.max(1, Math.round(rect.height));
  renderer.setSize(width, height, false);
  composer.setSize(width, height);
  rig.resize(width, height);
}

resize();
new ResizeObserver(() => resize()).observe(sceneEl);

// ── loop ───────────────────────────────────────────────────────────────────
let last = performance.now();
let readyAnnounced = false;

function tick(now: number): void {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const elapsed = now / 1000;

  if (city && buildDuration > 0) {
    buildProgress = Math.min(1, (now - buildStart) / buildDuration);
    city.setBuild(buildProgress);
    if (buildProgress >= 1) {
      buildDuration = 0;
      // the completed city powers on with a single sweep from its core
      waveClock = 0;
      waveIndex = 0;
      uniforms.uWaveOrigin.value.set(waveHome.x, waveHome.z);
    }
  }

  if (playing && data) {
    const perSecond = (data.frames.length / RUN_SECONDS) * speed;
    frameCursor += dt * perSecond;
    if (frameCursor >= data.frames.length - 1) {
      frameCursor = data.frames.length - 1;
      setFrame(frameCursor);
      stopPlayback();
      if (flying) rig.returnHome();
    } else {
      setFrame(frameCursor);
    }
    if (flying && data.frames.length > 1) {
      rig.applyFlythrough(frameCursor / (data.frames.length - 1));
    }
  }

  rig.update(dt);
  updateWave(STILL ? 0 : dt);
  city?.update(dt, elapsed);
  updateHover();

  composer.render();
  updateLabels(width, height);
  setNeedleRotation(rig.azimuth());

  if (!readyAnnounced && city) {
    readyAnnounced = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.documentElement.dataset.cityReady = "1";
      });
    });
  }
}

requestAnimationFrame(tick);
void boot();

if (import.meta.env.DEV) {
  Object.assign(window, {
    __codecity: {
      get data() {
        return data;
      },
      get city() {
        return city;
      },
      get replay() {
        return replay;
      },
      get slug() {
        return currentSlug;
      },
      rig,
      renderer,
      composer,
      world,
      uniforms,
      THREE,
    },
  });
}
