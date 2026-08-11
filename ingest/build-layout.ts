import type { Block, Building, District } from "./types.js";
import { LANGUAGE_NAMES, languageOf } from "./eligibility.js";

export interface PathStat {
  /** highest line count this path ever reached */
  peak: number;
  /** line count in the final frame (0 = deleted / never present) */
  final: number;
}

export interface LayoutOptions {
  /** hard cap on rendered buildings — this is the aggregation guard */
  maxBuildings: number;
  /**
   * A directory whose subtree holds more than this many files is a candidate
   * for collapsing before smaller ones. Only bites once the budget is tight.
   */
  aggregateThreshold: number;
}

export interface LayoutResult {
  /** language names, indexed by `Building.l` */
  languages: string[];
  districts: District[];
  blocks: Block[];
  buildings: Building[];
  /** every repo path → the building it contributes to (files share a slot when aggregated) */
  pathToBuilding: Map<string, number>;
  aggregates: number;
  /** true when at least one directory had to be collapsed */
  sampled: boolean;
}

/** one lot — a single building's plot, streets excluded */
const LOT = 1;
/** sidewalk inside a block, between the outermost lots and the block edge */
const BLOCK_PAD = 0.28;
/** street between two blocks of the same district */
const STREET = 1.15;
/**
 * Avenue between two districts. Wide enough to read as a boundary, narrow
 * enough that the repository stays one connected metropolis instead of a
 * scatter of islands floating in black.
 */
const AVENUE = 2.7;
/** margin between a district's blocks and its edge */
export const DISTRICT_PAD = 1;
/**
 * A block of three buildings is not a block, it is a rounding error. Folders
 * below this are merged into their parent's block; above the upper bound a
 * folder is split across several, so no single block swallows a district.
 */
const MIN_BLOCK_LOTS = 16;
const MAX_BLOCK_LOTS = 110;
/**
 * A folder holding more than this many buildings is split into sub-districts —
 * which is how a monorepo grows a real number of neighbourhoods instead of one
 * enormous slab. Folders below the lower bound are folded into the outskirts
 * rather than each claiming an avenue.
 */
const MAX_DISTRICT_LOTS = 1100;
const MIN_DISTRICT_LOTS = 55;
const OUTSKIRTS = "·outskirts";

// ---------------------------------------------------------------------------
// directory tree
// ---------------------------------------------------------------------------

/**
 * Weight of a file when the budget is tight. A file that still exists carries
 * its full size; one that was deleted keeps a fraction of its peak, so history
 * is not erased but never outranks live code.
 */
const DEAD_WEIGHT = 0.05;
/** How much a deleted file counts toward a folder's claim on the budget. */
const DEAD_SLOT_SHARE = 0.03;
/**
 * Sub-linear so a 9-file folder is not wiped out by a 9000-file one, but not
 * so flat (sqrt) that dozens of near-empty folders eat the whole budget.
 */
const SHARE_EXPONENT = 0.7;

interface FileLeaf {
  name: string;
  path: string;
  live: boolean;
  weight: number;
}

interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: FileLeaf[];
  fileCount: number;
  liveCount: number;
  weight: number;
}

function newDir(name: string, path: string): DirNode {
  return { name, path, dirs: new Map(), files: [], fileCount: 0, liveCount: 0, weight: 0 };
}

function insert(root: DirNode, filePath: string, leaf: Omit<FileLeaf, "name" | "path">): void {
  const parts = filePath.split("/");
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    let next = node.dirs.get(seg);
    if (!next) {
      next = newDir(seg, node.path ? `${node.path}/${seg}` : seg);
      node.dirs.set(seg, next);
    }
    node = next;
  }
  node.files.push({ name: parts[parts.length - 1], path: filePath, ...leaf });
}

function rollup(node: DirNode): void {
  let count = node.files.length;
  let live = 0;
  let weight = 0;
  for (const f of node.files) {
    weight += f.weight;
    if (f.live) live++;
  }
  for (const d of node.dirs.values()) {
    rollup(d);
    count += d.fileCount;
    live += d.liveCount;
    weight += d.weight;
  }
  node.fileCount = count;
  node.liveCount = live;
  node.weight = weight;
}

/** How strong a claim this subtree has on the building budget. */
function slotDemand(fileCount: number, liveCount: number): number {
  return Math.max(1, liveCount + (fileCount - liveCount) * DEAD_SLOT_SHARE);
}

function collectFiles(node: DirNode, out: string[]): void {
  for (const f of node.files) out.push(f.path);
  for (const d of node.dirs.values()) collectFiles(d, out);
}

// ---------------------------------------------------------------------------
// the aggregation guard
// ---------------------------------------------------------------------------

interface Slot {
  /** repo path — a file path, or the directory path for an aggregate */
  path: string;
  /** grouping key used to keep siblings spatially together */
  parent: string;
  name: string;
  /** every file this slot stands for */
  files: string[];
  /** 0 for a real file, otherwise how many files were folded in */
  aggregate: number;
  weight: number;
}

/**
 * Split `budget` slots across units. Every unit gets at least one; the rest is
 * shared by sqrt(demand) so a 12-file folder is not erased by a 9000-file one,
 * and no unit ever gets more slots than it has files. Requires
 * `budget >= caps.length`.
 */
function allocate(caps: number[], budget: number, demand: number[]): number[] {
  const n = caps.length;
  const alloc = new Array<number>(n).fill(1);
  let left = budget - n;
  if (left <= 0) return alloc;

  const w = demand.map((d) => Math.pow(Math.max(d, 0.01), SHARE_EXPONENT));
  const total = w.reduce((a, b) => a + b, 0) || 1;
  for (let i = 0; i < n; i++) {
    const extra = Math.min(caps[i] - alloc[i], Math.floor((left * w[i]) / total));
    if (extra > 0) alloc[i] += extra;
  }
  left = budget - alloc.reduce((a, b) => a + b, 0);

  // hand out whatever rounding left over, biggest unmet demand first
  const order = caps.map((_, i) => i).sort((a, b) => demand[b] - alloc[b] - (demand[a] - alloc[a]));
  let guard = 0;
  while (left > 0 && guard++ < n * 128) {
    let moved = false;
    for (const i of order) {
      if (left === 0) break;
      if (alloc[i] < caps[i]) {
        alloc[i]++;
        left--;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return alloc;
}

function aggregateSlot(node: DirNode, parent: string): Slot {
  const files: string[] = [];
  collectFiles(node, files);
  return {
    path: node.path,
    parent,
    name: `${node.name}/…`,
    files,
    aggregate: files.length,
    weight: node.weight,
  };
}

interface PlanCtx {
  collapsed: boolean;
  /** a folder this small is collapsed whole rather than split into part-blocks */
  threshold: number;
}

function plan(node: DirNode, budget: number, out: Slot[], state: PlanCtx): void {
  if (node.fileCount === 0) return;

  if (node.fileCount <= budget) {
    const files: FileLeaf[] = [];
    const walk = (n: DirNode) => {
      for (const f of n.files) files.push(f);
      for (const d of n.dirs.values()) walk(d);
    };
    walk(node);
    for (const f of files) {
      out.push({
        path: f.path,
        parent: f.path.slice(0, f.path.lastIndexOf("/") + 1),
        name: f.name,
        files: [f.path],
        aggregate: 0,
        weight: f.weight,
      });
    }
    return;
  }

  state.collapsed = true;

  // One honest block beats three arbitrary half-blocks: a folder at or under
  // the threshold that cannot be shown in full is collapsed whole.
  if (budget <= 1 || node.fileCount <= state.threshold) {
    out.push(aggregateSlot(node, node.path));
    return;
  }

  type Unit =
    | { kind: "dir"; node: DirNode; count: number; demand: number; weight: number }
    | { kind: "file"; file: FileLeaf; count: 1; demand: number; weight: number };

  const units: Unit[] = [];
  for (const d of node.dirs.values()) {
    units.push({
      kind: "dir",
      node: d,
      count: d.fileCount,
      demand: slotDemand(d.fileCount, d.liveCount),
      weight: d.weight,
    });
  }
  for (const f of node.files) {
    units.push({
      kind: "file",
      file: f,
      count: 1,
      demand: f.live ? 1 : DEAD_SLOT_SHARE,
      weight: f.weight,
    });
  }
  // live, heavy folders keep their detail; the dead tail gets folded together
  const unitKey = (u: Unit) => (u.kind === "dir" ? u.node.path : u.file.path);
  units.sort(
    (a, b) =>
      b.weight - a.weight ||
      b.demand - a.demand ||
      (unitKey(a) < unitKey(b) ? -1 : unitKey(a) > unitKey(b) ? 1 : 0),
  );

  let keep = units;
  if (units.length > budget) {
    keep = units.slice(0, budget - 1);
    const rest = units.slice(budget - 1);
    const files: string[] = [];
    let weight = 0;
    for (const u of rest) {
      weight += u.weight;
      if (u.kind === "file") files.push(u.file.path);
      else collectFiles(u.node, files);
    }
    out.push({
      path: `${node.path}/…`,
      parent: node.path,
      name: `…${rest.length} more`,
      files,
      aggregate: files.length,
      weight,
    });
  }

  const budgetForKeep = keep.length === units.length ? budget : budget - 1;
  const alloc = allocate(
    keep.map((u) => u.count),
    budgetForKeep,
    keep.map((u) => u.demand),
  );

  keep.forEach((u, i) => {
    if (u.kind === "file") {
      out.push({
        path: u.file.path,
        parent: u.file.path.slice(0, u.file.path.lastIndexOf("/") + 1),
        name: u.file.name,
        files: [u.file.path],
        aggregate: 0,
        weight: u.file.weight,
      });
    } else {
      plan(u.node, alloc[i], out, state);
    }
  });
}

// ---------------------------------------------------------------------------
// placement
// ---------------------------------------------------------------------------

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

/**
 * Shelf packing with a square-ish target, laid out from the middle outward.
 *
 * `rects` arrives in weight order, and that order is preserved through the
 * placement: the first rect lands in the centre of the middle row, and each
 * next one steps alternately right/left within a row and below/above between
 * rows. So the heaviest folders end up downtown and the light ones on the
 * fringe, without any of it being random.
 *
 * The `gap` left around every rect is what becomes a street or an avenue.
 */
function packRects(rects: Rect[], gap: number): void {
  if (rects.length === 0) return;

  let area = 0;
  for (const r of rects) area += (r.w + gap) * (r.d + gap);
  // slightly wide of square: cities read better long than tall on screen
  const targetWidth = Math.max(Math.sqrt(area * 1.2), rects[0].w + gap);

  interface Row {
    items: Rect[];
    width: number;
    depth: number;
  }

  const rows: Row[] = [];
  let row: Row = { items: [], width: 0, depth: 0 };
  for (const r of rects) {
    if (row.items.length > 0 && row.width + r.w + gap > targetWidth) {
      rows.push(row);
      row = { items: [], width: 0, depth: 0 };
    }
    row.items.push(r);
    row.width += r.w + gap;
    row.depth = Math.max(row.depth, r.d);
  }
  if (row.items.length > 0) rows.push(row);

  // rows outward from the middle: 0 centre, then below, above, below…
  let below = 0;
  let above = 0;
  rows.forEach((current, i) => {
    let z: number;
    if (i === 0) {
      z = -current.depth / 2;
      below = current.depth / 2;
      above = -current.depth / 2;
    } else if (i % 2 === 1) {
      z = below + gap;
      below = z + current.depth;
    } else {
      z = above - gap - current.depth;
      above = z;
    }

    // items outward from the middle of the row, same reason
    const ordered: Rect[] = [];
    current.items.forEach((item, k) => {
      if (k % 2 === 0) ordered.push(item);
      else ordered.unshift(item);
    });

    let x = -(current.width - gap) / 2;
    for (const item of ordered) {
      item.x = x;
      item.z = z + (current.depth - item.d) / 2;
      x += item.w + gap;
    }
  });

  recentre(rects);
}

/** shift a set of placed rects so their bounding box is centred on the origin */
function recentre(rects: Rect[]): void {
  const minX = Math.min(...rects.map((q) => q.x));
  const maxX = Math.max(...rects.map((q) => q.x + q.w));
  const minZ = Math.min(...rects.map((q) => q.z));
  const maxZ = Math.max(...rects.map((q) => q.z + q.d));
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  for (const q of rects) {
    q.x -= cx;
    q.z -= cz;
  }
}

/** cols × rows for `n` lots, biased slightly wide so blocks front a street */
function gridFor(n: number, aspect = 1.35): { cols: number; rows: number } {
  const cols = Math.max(1, Math.round(Math.sqrt(n * aspect)));
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}

// ---------------------------------------------------------------------------

export function buildLayout(
  stats: Map<string, PathStat>,
  sizes: Map<string, number>,
  opts: LayoutOptions,
): LayoutResult {
  // Weight drives which files keep an individual building when the budget is
  // tight. Peak-ever matters as much as the final size: a file that was huge
  // and then deleted is part of the story.
  const districtRoots = new Map<string, DirNode>();
  // Sorted so the tree — and therefore every downstream tie-break — depends
  // only on the set of paths, never on Map insertion order. Same commit set in,
  // same city out, every time.
  const paths = [...stats.keys()].sort();
  for (const path of paths) {
    const stat = stats.get(path)!;
    const slash = path.indexOf("/");
    const districtName = slash === -1 ? "/" : path.slice(0, slash);
    let root = districtRoots.get(districtName);
    if (!root) {
      root = newDir(districtName, districtName === "/" ? "" : districtName);
      districtRoots.set(districtName, root);
    }
    const live = stat.final > 0;
    insert(root, path, {
      live,
      weight: live ? Math.max(stat.final, 1) : Math.max(stat.peak * DEAD_WEIGHT, 0.01),
    });
  }
  for (const root of districtRoots.values()) rollup(root);

  const ordered = [...districtRoots.entries()].sort(
    (a, b) =>
      b[1].weight - a[1].weight ||
      b[1].fileCount - a[1].fileCount ||
      (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );

  // Districts share the global building budget, sqrt-weighted so small folders
  // survive next to a giant one, and biased toward folders that still exist.
  const counts = ordered.map(([, n]) => n.fileCount);
  const demands = ordered.map(([, n]) => slotDemand(n.fileCount, n.liveCount));
  const totalFiles = counts.reduce((a, b) => a + b, 0);
  const budgets =
    totalFiles <= opts.maxBuildings
      ? counts.slice()
      : allocate(counts, Math.max(opts.maxBuildings, counts.length), demands);

  const languages = ["Other", ...LANGUAGE_NAMES];
  const languageIds = new Map(languages.map((name, i) => [name, i]));
  const languageIndex = (name: string) => languageIds.get(name) ?? 0;

  const state: PlanCtx = { collapsed: false, threshold: opts.aggregateThreshold };
  const districts: District[] = [];
  const buildings: Building[] = [];
  const pathToBuilding = new Map<string, number>();
  const rects: Rect[] = [];
  let aggregates = 0;

  const planned = ordered.map(([, node], di) => {
    const slots: Slot[] = [];
    plan(node, budgets[di], slots, state);
    return slots;
  });

  // Collapsing whole small folders leaves slots on the table. Hand the unused
  // budget back to the districts that were actually starved, and re-plan them.
  for (let pass = 0; pass < 3; pass++) {
    const emitted = planned.reduce((a, s) => a + s.length, 0);
    const leftover = opts.maxBuildings - emitted;
    if (leftover < 8) break;

    let starved = ordered
      .map((_, i) => i)
      .filter((i) => planned[i].length >= budgets[i] && ordered[i][1].fileCount > budgets[i])
      .sort((a, b) => demands[b] - demands[a]);
    if (starved.length === 0) break;
    // `allocate` hands every unit at least one slot, so never ask more units
    // than there are slots to give.
    if (starved.length > leftover) starved = starved.slice(0, leftover);

    const extra = allocate(
      starved.map((i) => ordered[i][1].fileCount - budgets[i]),
      leftover,
      starved.map((i) => demands[i]),
    );
    for (let k = 0; k < starved.length; k++) {
      const i = starved[k];
      budgets[i] += extra[k];
      const slots: Slot[] = [];
      plan(ordered[i][1], budgets[i], slots, state);
      planned[i] = slots;
    }
  }

  // ── districts → blocks → lots ────────────────────────────────────────────
  // Blocks come straight out of the folder tree: every immediate parent folder
  // in a district becomes one block, so the streets between them are the
  // repository's own hierarchy made visible.
  interface PendingBlock {
    path: string;
    slots: Slot[];
    cols: number;
    rows: number;
    rect: Rect;
    plaza: boolean;
  }

  // Districting is a walk down the folder tree, not a flat cut at depth one:
  // descend while a folder is too big to be one neighbourhood, stop as soon as
  // it fits or the next level down is a twig. A monorepo therefore grows
  // sub-districts, and a small repo keeps its top-level folders.
  const allSlots = planned.flat();

  const prefixCount = new Map<string, number>();
  const dirOf = (p: string) => {
    const i = p.lastIndexOf("/");
    return i === -1 ? "" : p.slice(0, i);
  };
  for (const slot of allSlots) {
    const parts = dirOf(slot.path).split("/").filter(Boolean);
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      prefixCount.set(acc, (prefixCount.get(acc) ?? 0) + 1);
    }
  }

  const districtKey = (slotPath: string): string => {
    const parts = dirOf(slotPath).split("/").filter(Boolean);
    if (parts.length === 0) return "/";
    let key = parts[0];
    for (let depth = 1; depth < parts.length; depth++) {
      if ((prefixCount.get(key) ?? 0) <= MAX_DISTRICT_LOTS) break;
      const next = `${key}/${parts[depth]}`;
      if ((prefixCount.get(next) ?? 0) < MIN_DISTRICT_LOTS) break;
      key = next;
    }
    return key;
  };

  const byDistrict = new Map<string, Slot[]>();
  for (const slot of allSlots) {
    const key = districtKey(slot.path);
    const bucket = byDistrict.get(key);
    if (bucket) bucket.push(slot);
    else byDistrict.set(key, [slot]);
  }

  // Fold the long tail of tiny districts into one outskirts district. They keep
  // their own blocks, so nothing is hidden — they just stop each demanding an
  // avenue of their own.
  const groupsOut: Array<{ name: string; path: string; slots: Slot[]; files: number }> = [];
  const tail: Slot[] = [];

  const sortedKeys = [...byDistrict.keys()].sort((a, b) => {
    const d = byDistrict.get(b)!.length - byDistrict.get(a)!.length;
    return d || (a < b ? -1 : a > b ? 1 : 0);
  });
  const keepAnyway = new Set(sortedKeys.slice(0, 4));

  for (const key of sortedKeys) {
    const slots = byDistrict.get(key)!;
    if (slots.length >= MIN_DISTRICT_LOTS || keepAnyway.has(key)) {
      const parts = key.split("/");
      groupsOut.push({
        name: parts[parts.length - 1] || "/",
        path: key,
        slots,
        files: slots.length,
      });
    } else {
      tail.push(...slots);
    }
  }
  if (tail.length > 0) {
    groupsOut.push({ name: "OUTSKIRTS", path: OUTSKIRTS, slots: tail, files: tail.length });
  }

  const pendingPerDistrict: PendingBlock[][] = [];

  groupsOut.forEach((group) => {
    const node = { path: group.path };
    const slots = group.slots;

    // How many slots sit under every folder prefix in this district. A block is
    // then the *deepest* folder that still owns enough buildings to be worth a
    // street of its own, which is what keeps the hierarchy readable instead of
    // shattering it into three-building fragments.
    const prefixCount = new Map<string, number>();
    for (const slot of slots) {
      const parts = slot.parent.split("/").filter(Boolean);
      for (let i = parts.length; i >= 1; i--) {
        const key = parts.slice(0, i).join("/");
        prefixCount.set(key, (prefixCount.get(key) ?? 0) + 1);
      }
    }

    const blockKey = (parent: string): string => {
      const parts = parent.split("/").filter(Boolean);
      for (let i = parts.length; i >= 1; i--) {
        const key = parts.slice(0, i).join("/");
        if ((prefixCount.get(key) ?? 0) >= MIN_BLOCK_LOTS) return key;
      }
      return parts[0] ?? node.path;
    };

    const merged = new Map<string, Slot[]>();
    for (const slot of slots) {
      const key = blockKey(slot.parent);
      const bucket = merged.get(key);
      if (bucket) bucket.push(slot);
      else merged.set(key, [slot]);
    }

    // split anything oversized into evenly sized sibling blocks
    const groups = new Map<string, Slot[]>();
    for (const [key, group] of merged) {
      if (group.length <= MAX_BLOCK_LOTS) {
        groups.set(key, group);
        continue;
      }
      const parts = Math.ceil(group.length / MAX_BLOCK_LOTS);
      const size = Math.ceil(group.length / parts);
      for (let p = 0; p < parts; p++) {
        groups.set(`${key}#${p + 1}`, group.slice(p * size, (p + 1) * size));
      }
    }

    const pending: PendingBlock[] = [...groups.entries()]
      .map(([path, group]) => {
        // heaviest first inside a block, so the sort below is stable and the
        // centre-out assignment has something meaningful to order by
        group.sort(
          (a, b) =>
            b.weight - a.weight ||
            hash32(a.path) - hash32(b.path) ||
            (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
        );
        const { cols, rows } = gridFor(group.length);
        return {
          path,
          slots: group,
          cols,
          rows,
          plaza: false,
          rect: {
            x: 0,
            z: 0,
            w: cols * LOT + BLOCK_PAD * 2,
            d: rows * LOT + BLOCK_PAD * 2,
          },
        };
      })
      // heavy blocks are packed first, which lands them in the district core
      .sort((a, b) => {
        const wa = a.slots.reduce((s, x) => s + x.weight, 0);
        const wb = b.slots.reduce((s, x) => s + x.weight, 0);
        return wb - wa || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      });

    // A city needs somewhere for nothing to happen. One deterministic plaza
    // per reasonably sized district, sized like a median block.
    if (pending.length >= 6) {
      const median = pending[Math.floor(pending.length / 2)];
      const at = 1 + (hash32(`plaza:${node.path}`) % Math.max(1, pending.length - 2));
      pending.splice(at, 0, {
        path: `${node.path}/·plaza`,
        slots: [],
        cols: 0,
        rows: 0,
        plaza: true,
        rect: { x: 0, z: 0, w: median.rect.w * 0.72, d: median.rect.d * 0.72 },
      });
    }

    packRects(
      pending.map((b) => b.rect),
      STREET,
    );
    pendingPerDistrict.push(pending);
  });

  // ── district plates from their packed blocks ─────────────────────────────
  groupsOut.forEach((group, di) => {
    const pending = pendingPerDistrict[di];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const b of pending) {
      minX = Math.min(minX, b.rect.x);
      maxX = Math.max(maxX, b.rect.x + b.rect.w);
      minZ = Math.min(minZ, b.rect.z);
      maxZ = Math.max(maxZ, b.rect.z + b.rect.d);
    }

    // shift the district's blocks so its plate starts at the local origin
    for (const b of pending) {
      b.rect.x += DISTRICT_PAD - minX;
      b.rect.z += DISTRICT_PAD - minZ;
    }

    const rect: Rect = {
      x: 0,
      z: 0,
      w: maxX - minX + DISTRICT_PAD * 2,
      d: maxZ - minZ + DISTRICT_PAD * 2,
    };
    rects.push(rect);

    districts.push({
      name: group.name,
      path: group.path,
      px: 0,
      pz: 0,
      pw: rect.w,
      pd: rect.d,
      cells: pending.reduce((s, b) => s + b.cols * b.rows, 0),
      lots: group.slots.length,
      lines: 0,
    });
  });

  packRects(rects, AVENUE);
  districts.forEach((d, i) => {
    d.px = rects[i].x;
    d.pz = rects[i].z;
  });

  // ── lots ─────────────────────────────────────────────────────────────────
  const blocks: Block[] = [];

  districts.forEach((district, di) => {
    const cx = district.px + district.pw / 2;
    const cz = district.pz + district.pd / 2;

    for (const pending of pendingPerDistrict[di]) {
      const bx = district.px + pending.rect.x;
      const bz = district.pz + pending.rect.z;
      const blockIndex = blocks.length;

      blocks.push({
        d: di,
        path: pending.path,
        x: bx,
        z: bz,
        w: pending.rect.w,
        h: pending.rect.d,
        cols: pending.cols,
        rows: pending.rows,
        lots: pending.slots.length,
        plaza: pending.plaza,
      });
      if (pending.plaza) continue;

      // Lots are a plain grid, which is what keeps rows facing the street.
      // Only the *assignment* is reordered: the heaviest file in the block goes
      // to the lot closest to the district core, so the skyline peaks downtown
      // instead of scattering. The metric itself is untouched.
      const lots: Array<{ x: number; z: number; d: number }> = [];
      for (let r = 0; r < pending.rows; r++) {
        for (let c = 0; c < pending.cols; c++) {
          const x = bx + BLOCK_PAD + (c + 0.5) * LOT;
          const z = bz + BLOCK_PAD + (r + 0.5) * LOT;
          lots.push({ x, z, d: Math.hypot(x - cx, z - cz) });
        }
      }
      lots.sort((a, b) => a.d - b.d || a.x - b.x || a.z - b.z);

      pending.slots.forEach((slot, i) => {
        const lot = lots[i];
        const index = buildings.length;
        let bytes = 0;
        for (const f of slot.files) bytes += sizes.get(f) ?? 0;
        buildings.push({
          d: di,
          k: blockIndex,
          x: lot.x,
          z: lot.z,
          n: slot.name,
          p: slot.path,
          a: slot.aggregate,
          b: bytes,
          l: languageIndex(languageOf(slot.files[0] ?? slot.path)),
        });
        if (slot.aggregate > 0) aggregates++;
        for (const f of slot.files) pathToBuilding.set(f, index);
      });
    }
  });

  return {
    languages,
    districts,
    blocks,
    buildings,
    pathToBuilding,
    aggregates,
    sampled: state.collapsed,
  };
}
