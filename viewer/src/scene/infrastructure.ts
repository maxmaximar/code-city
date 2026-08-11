import * as THREE from "three";
import type { CityData } from "../../../ingest/types.js";
import { conduitMaterial, groundMaterial, nodeMaterial, type CityUniforms } from "./materials.js";

/** heights, in world units, of the stacked ground layers */
const Y_GROUND = -0.6;
const Y_PLATE = -0.05;
const Y_CONDUIT = -0.02;
const Y_NODE = -0.015;
const Y_PAD = 0;

const CONDUIT_WIDTH = 0.26;
const NODE_SIZE = 0.55;

const TRUNK_TINT = new THREE.Color(0x63e6ff);
const RING_TINT = new THREE.Color(0x2f93b4);
/** how far outside a district plate its ring runs, as a share of the avenue */
const RING_OFFSET = 1.25;

interface Rect {
  x: number;
  z: number;
  w: number;
  h: number;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.z < b.z + b.h && a.z + a.h > b.z;
}

/** axis-aligned segment, widened to the conduit's own width */
function segmentRect(x0: number, z0: number, x1: number, z1: number): Rect {
  const half = CONDUIT_WIDTH;
  return {
    x: Math.min(x0, x1) - half,
    z: Math.min(z0, z1) - half,
    w: Math.abs(x1 - x0) + half * 2,
    h: Math.abs(z1 - z0) + half * 2,
  };
}

class QuadMesher {
  readonly position: number[] = [];
  readonly kind: number[] = [];

  plate(x: number, z: number, w: number, h: number, y: number, kind: number): void {
    const push = (px: number, pz: number) => {
      this.position.push(px, y, pz);
      this.kind.push(kind);
    };
    push(x, z);
    push(x, z + h);
    push(x + w, z + h);
    push(x, z);
    push(x + w, z + h);
    push(x + w, z);
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.position, 3));
    geometry.setAttribute("aKind", new THREE.Float32BufferAttribute(this.kind, 1));
    return geometry;
  }
}

class ConduitMesher {
  readonly position: number[] = [];
  readonly along: number[] = [];
  readonly length: number[] = [];
  readonly side: number[] = [];
  readonly route: number[] = [];
  readonly tint: number[] = [];

  /** One axis-aligned polyline becomes one strip; `seed` drives its packet timing. */
  path(points: Array<[number, number]>, seed: number, tint: THREE.Color): void {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    }
    if (total < 0.2) return;

    let travelled = 0;
    for (let i = 1; i < points.length; i++) {
      const [x0, z0] = points[i - 1];
      const [x1, z1] = points[i];
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (len < 1e-4) continue;

      // perpendicular, in the ground plane
      const nx = (-dz / len) * CONDUIT_WIDTH;
      const nz = (dx / len) * CONDUIT_WIDTH;

      const a = travelled;
      const b = travelled + len;
      const push = (px: number, pz: number, alongValue: number, sideValue: number) => {
        this.position.push(px, Y_CONDUIT, pz);
        this.along.push(alongValue);
        this.length.push(total);
        this.side.push(sideValue);
        this.route.push(seed);
        this.tint.push(tint.r, tint.g, tint.b);
      };

      push(x0 - nx, z0 - nz, a, -1);
      push(x0 + nx, z0 + nz, a, 1);
      push(x1 + nx, z1 + nz, b, 1);
      push(x0 - nx, z0 - nz, a, -1);
      push(x1 + nx, z1 + nz, b, 1);
      push(x1 - nx, z1 - nz, b, -1);

      travelled = b;
    }
  }

  get empty(): boolean {
    return this.position.length === 0;
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.position, 3));
    geometry.setAttribute("aAlong", new THREE.Float32BufferAttribute(this.along, 1));
    geometry.setAttribute("aLength", new THREE.Float32BufferAttribute(this.length, 1));
    geometry.setAttribute("aSide", new THREE.Float32BufferAttribute(this.side, 1));
    geometry.setAttribute("aRoute", new THREE.Float32BufferAttribute(this.route, 1));
    geometry.setAttribute("aTint", new THREE.Float32BufferAttribute(this.tint, 3));
    return geometry;
  }
}

class NodeMesher {
  readonly position: number[] = [];
  readonly centre: number[] = [];
  readonly scale: number[] = [];
  readonly seed: number[] = [];
  readonly tint: number[] = [];

  at(x: number, z: number, size: number, seed: number, tint: THREE.Color): void {
    const corners: Array<[number, number]> = [
      [-0.5, -0.5],
      [-0.5, 0.5],
      [0.5, 0.5],
      [-0.5, -0.5],
      [0.5, 0.5],
      [0.5, -0.5],
    ];
    for (const [cx, cz] of corners) {
      this.position.push(cx, 0, cz);
      this.centre.push(x, Y_NODE, z);
      this.scale.push(size);
      this.seed.push(seed);
      this.tint.push(tint.r, tint.g, tint.b);
    }
  }

  get empty(): boolean {
    return this.position.length === 0;
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.position, 3));
    geometry.setAttribute("aCentre", new THREE.Float32BufferAttribute(this.centre, 3));
    geometry.setAttribute("aScale", new THREE.Float32BufferAttribute(this.scale, 1));
    geometry.setAttribute("aSeed", new THREE.Float32BufferAttribute(this.seed, 1));
    geometry.setAttribute("aTint", new THREE.Float32BufferAttribute(this.tint, 3));
    return geometry;
  }
}

export interface Infrastructure {
  group: THREE.Group;
  /** y the buildings' bases sit at — the top of a block pad */
  padY: number;
  dispose(): void;
}

/**
 * Ground, blocks and the energy network. All of it is derived from the same
 * district/block rectangles the buildings stand on, so the roads explain the
 * repository's folder hierarchy rather than decorating it.
 *
 * Everything animates from uniforms: no geometry is rebuilt per frame.
 */
export function buildInfrastructure(data: CityData, uniforms: CityUniforms): Infrastructure {
  const group = new THREE.Group();
  const disposables: Array<{ dispose(): void }> = [];

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
  const span = Math.max(maxX - minX, maxZ - minZ) || 10;
  const centreX = (minX + maxX) / 2;
  const centreZ = (minZ + maxZ) / 2;

  // ── ground ───────────────────────────────────────────────────────────────
  const groundGeo = new THREE.PlaneGeometry(span * 14, span * 14);
  groundGeo.rotateX(-Math.PI / 2);
  const groundMat = new THREE.MeshBasicMaterial({ color: 0x02040a });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.position.set(centreX, Y_GROUND, centreZ);
  group.add(ground);
  disposables.push(groundGeo, groundMat);

  // ── district plates and block pads ───────────────────────────────────────
  const quads = new QuadMesher();
  for (const d of data.districts) quads.plate(d.px, d.pz, d.pw, d.pd, Y_PLATE, 0);
  for (const b of data.blocks) {
    if (!b.plaza) quads.plate(b.x, b.z, b.w, b.h, Y_PAD, 1);
  }
  const surfaceGeo = quads.build();
  const surfaceMat = groundMaterial(uniforms);
  group.add(new THREE.Mesh(surfaceGeo, surfaceMat));
  disposables.push(surfaceGeo, surfaceMat);

  // ── block outlines ───────────────────────────────────────────────────────
  const outline: number[] = [];
  const y = Y_PAD + 0.004;
  for (const b of data.blocks) {
    const [x0, x1, z0, z1] = [b.x, b.x + b.w, b.z, b.z + b.h];
    outline.push(x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1);
    outline.push(x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0);
  }
  const outlineGeo = new THREE.BufferGeometry();
  outlineGeo.setAttribute("position", new THREE.Float32BufferAttribute(outline, 3));
  const outlineMat = new THREE.LineBasicMaterial({
    color: 0x1d3138,
    transparent: true,
    opacity: 0.4,
  });
  group.add(new THREE.LineSegments(outlineGeo, outlineMat));
  disposables.push(outlineGeo, outlineMat);

  // ── energy network ───────────────────────────────────────────────────────
  const blockRects: Rect[] = data.blocks
    .filter((b) => !b.plaza)
    .map((b) => ({ x: b.x, z: b.z, w: b.w, h: b.h }));

  const clear = (x0: number, z0: number, x1: number, z1: number): boolean => {
    const r = segmentRect(x0, z0, x1, z1);
    return !blockRects.some((b) => rectsOverlap(r, b));
  };

  const conduits = new ConduitMesher();
  const nodes = new NodeMesher();

  data.districts.forEach((d, i) => {
    const cx = d.px + d.pw / 2;
    const cz = d.pz + d.pd / 2;

    // The loop runs in the avenue *outside* the plate. Districts are packed
    // with a fixed avenue between them, so neighbouring loops come close
    // without ever touching, and the network reads as the road grid it is.
    const rx0 = d.px - RING_OFFSET;
    const rx1 = d.px + d.pw + RING_OFFSET;
    const rz0 = d.pz - RING_OFFSET;
    const rz1 = d.pz + d.pd + RING_OFFSET;
    conduits.path(
      [
        [rx0, rz0],
        [rx1, rz0],
        [rx1, rz1],
        [rx0, rz1],
        [rx0, rz0],
      ],
      (i * 0.37) % 1,
      RING_TINT,
    );
    for (const [nx, nz] of [
      [rx0, rz0],
      [rx1, rz0],
      [rx1, rz1],
      [rx0, rz1],
    ]) {
      nodes.at(nx, nz, NODE_SIZE, (i * 0.21 + 0.13) % 1, RING_TINT);
    }

    // Trunk from the city core to this district. Both L-orientations are tested
    // against the real block rects; if neither is clear the trunk is dropped
    // rather than run through somebody's building.
    const nearX = Math.abs(cx - centreX) < 1e-6 ? cx : cx > centreX ? rx0 : rx1;
    const nearZ = Math.abs(cz - centreZ) < 1e-6 ? cz : cz > centreZ ? rz0 : rz1;

    const candidates: Array<Array<[number, number]>> = [
      [
        [centreX, centreZ],
        [nearX, centreZ],
        [nearX, nearZ],
      ],
      [
        [centreX, centreZ],
        [centreX, nearZ],
        [nearX, nearZ],
      ],
    ];

    for (const route of candidates) {
      let ok = true;
      for (let s = 1; s < route.length; s++) {
        if (!clear(route[s - 1][0], route[s - 1][1], route[s][0], route[s][1])) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      conduits.path(route, (i * 0.61 + 0.07) % 1, TRUNK_TINT);
      nodes.at(route[1][0], route[1][1], NODE_SIZE * 1.15, (i * 0.53) % 1, TRUNK_TINT);
      break;
    }
  });

  nodes.at(centreX, centreZ, NODE_SIZE * 2.2, 0.5, TRUNK_TINT);

  if (!conduits.empty) {
    const conduitGeo = conduits.build();
    const conduitMat = conduitMaterial(uniforms);
    const mesh = new THREE.Mesh(conduitGeo, conduitMat);
    mesh.renderOrder = 2;
    group.add(mesh);
    disposables.push(conduitGeo, conduitMat);
  }

  if (!nodes.empty) {
    const nodeGeo = nodes.build();
    const nodeMat = nodeMaterial(uniforms);
    const mesh = new THREE.Mesh(nodeGeo, nodeMat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    group.add(mesh);
    disposables.push(nodeGeo, nodeMat);
  }

  return {
    group,
    padY: Y_PAD,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
