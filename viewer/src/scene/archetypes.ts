import * as THREE from "three";

/**
 * A procedural architectural kit.
 *
 * Every archetype is built in a unit box — footprint in [-0.5, 0.5] on x and z,
 * height in [0, 1] — so a single instance matrix can scale it to a real
 * footprint and a real height without touching its proportions. A podium that
 * is 18% of the building stays 18% whether the file is 40 lines or 40,000.
 *
 * Detail lives in the silhouette, not the polygon count: the whole kit is a few
 * thousand vertices, and every building on screen is one instance of one of
 * these.
 */

interface Face {
  /** 0 at the bottom of the volume this face belongs to, 1 at its top */
  trim: [number, number, number, number];
  /** 0 and 1 at the two vertical edges of a wall; 0.5 on a cap, which has none */
  edge: [number, number, number, number];
  volume: number;
}

/** walls: bright vertical corner lines · caps: nothing to outline */
const WALL_EDGE: [number, number, number, number] = [0, 1, 1, 0];
const CAP_EDGE: [number, number, number, number] = [0.5, 0.5, 0.5, 0.5];

class Mesher {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly trim: number[] = [];
  readonly edge: number[] = [];
  readonly volume: number[] = [];
  private volumes = 0;

  private quad(
    a: THREE.Vector3Like,
    b: THREE.Vector3Like,
    c: THREE.Vector3Like,
    d: THREE.Vector3Like,
    face: Face,
  ): void {
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const uz = b.z - a.z;
    const vx = d.x - a.x;
    const vy = d.y - a.y;
    const vz = d.z - a.z;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    const push = (p: THREE.Vector3Like, i: number) => {
      this.position.push(p.x, p.y, p.z);
      this.normal.push(nx, ny, nz);
      this.trim.push(face.trim[i]);
      this.edge.push(face.edge[i]);
      this.volume.push(face.volume);
    };

    push(a, 0);
    push(b, 1);
    push(c, 2);
    push(a, 0);
    push(c, 2);
    push(d, 3);
  }

  /**
   * One volume: a box, or a frustum when the top rect differs from the bottom.
   * The underside is never emitted — the camera lives above the city.
   */
  volumeBox(
    bottom: [number, number, number, number],
    top: [number, number, number, number],
    y0: number,
    y1: number,
  ): void {
    const v = this.volumes++;
    const [bx0, bz0, bx1, bz1] = bottom;
    const [tx0, tz0, tx1, tz1] = top;

    const B = (x: number, z: number) => ({ x, y: y0, z });
    const T = (x: number, z: number) => ({ x, y: y1, z });
    const side: Face = { trim: [0, 0, 1, 1], edge: WALL_EDGE, volume: v };

    this.quad(B(bx0, bz1), B(bx1, bz1), T(tx1, tz1), T(tx0, tz1), side); // +z
    this.quad(B(bx1, bz0), B(bx0, bz0), T(tx0, tz0), T(tx1, tz0), side); // −z
    this.quad(B(bx1, bz1), B(bx1, bz0), T(tx1, tz0), T(tx1, tz1), side); // +x
    this.quad(B(bx0, bz0), B(bx0, bz1), T(tx0, tz1), T(tx0, tz0), side); // −x

    this.quad(T(tx0, tz0), T(tx0, tz1), T(tx1, tz1), T(tx1, tz0), {
      trim: [1, 1, 1, 1],
      edge: CAP_EDGE,
      volume: v,
    });
  }

  /** A box: the common case, where the top rect equals the bottom. */
  box(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number): void {
    this.volumeBox([x0, z0, x1, z1], [x0, z0, x1, z1], y0, y1);
  }

  /** Regular prism — chamfered and octagonal towers, optionally tapered. */
  prism(sides: number, rBottom: number, rTop: number, y0: number, y1: number, twist = 0): void {
    const v = this.volumes++;
    const pt = (r: number, i: number, y: number) => {
      const a = twist + (i / sides) * Math.PI * 2;
      return { x: Math.cos(a) * r, y, z: Math.sin(a) * r };
    };
    for (let i = 0; i < sides; i++) {
      this.quad(pt(rBottom, i, y0), pt(rBottom, i + 1, y0), pt(rTop, i + 1, y1), pt(rTop, i, y1), {
        trim: [0, 0, 1, 1],
        edge: WALL_EDGE,
        volume: v,
      });
    }
    const centre = { x: 0, y: y1, z: 0 };
    for (let i = 0; i < sides; i++) {
      this.quad(centre, pt(rTop, i, y1), pt(rTop, i + 1, y1), centre, {
        trim: [1, 1, 1, 1],
        edge: CAP_EDGE,
        volume: v,
      });
    }
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.position, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(this.normal, 3));
    geometry.setAttribute("aTrim", new THREE.Float32BufferAttribute(this.trim, 1));
    geometry.setAttribute("aEdge", new THREE.Float32BufferAttribute(this.edge, 1));
    const scale = Math.max(1, this.volumes - 1);
    geometry.setAttribute(
      "aVolume",
      new THREE.Float32BufferAttribute(
        this.volume.map((v) => v / scale),
        1,
      ),
    );
    return geometry;
  }
}

/** `v` is the quantised variant, 0…2 — small proportion shifts, same silhouette family. */
type Builder = (m: Mesher, v: number) => void;

const H = 0.5;

const LOW: Builder[] = [
  // wide slab with a parapet
  (m, v) => {
    const cap = 0.9 + v * 0.02;
    m.box(-H, -H, H, H, 0, cap);
    m.box(-H + 0.05, -H + 0.05, H - 0.05, H - 0.05, cap, 1);
  },
  // low block with an offset upper storey
  (m, v) => {
    const split = 0.62 + v * 0.06;
    m.box(-H, -H, H, H, 0, split);
    m.box(-H + 0.06, -H + 0.1, H - 0.16, H - 0.06, split, 1);
  },
  // L-shaped courtyard block
  (m, v) => {
    const arm = 0.1 + v * 0.06;
    m.box(-H, -H, arm, H, 0, 1);
    m.box(arm + 0.04, -H, H, 0.02, 0, 0.74 + v * 0.05);
  },
  // podium with a small upper volume
  (m, v) => {
    const podium = 0.34 + v * 0.05;
    m.box(-H, -H, H, H, 0, podium);
    m.box(-0.34, -0.34, 0.34, 0.34, podium, 1);
  },
  // paired low volumes on a shared base
  (m, v) => {
    m.box(-H, -H, H, H, 0, 0.24);
    m.box(-0.46, -0.4, -0.06, 0.4, 0.24, 1);
    m.box(0.06, -0.4, 0.46, 0.4, 0.24, 0.8 + v * 0.06);
  },
];

const MID: Builder[] = [
  // podium + tower
  (m, v) => {
    const podium = 0.16 + v * 0.04;
    const w = 0.32 - v * 0.02;
    m.box(-H, -H, H, H, 0, podium);
    m.box(-w, -w, w, w, podium, 1);
  },
  // two setbacks
  (m, v) => {
    const a = 0.4 + v * 0.04;
    m.box(-H, -H, H, H, 0, a);
    m.box(-0.38, -0.38, 0.38, 0.38, a, 0.76);
    m.box(-0.25, -0.25, 0.25, 0.25, 0.76, 1);
  },
  // thin slab with a service core on the roof
  (m, v) => {
    const depth = 0.26 + v * 0.04;
    m.box(-H, -depth, H, depth, 0, 0.88);
    m.box(-0.16, -depth + 0.04, 0.16, depth - 0.04, 0.88, 1);
  },
  // chamfered octagonal tower
  (m, v) => {
    m.prism(8, H, 0.44 - v * 0.03, 0, 0.93, Math.PI / 8);
    m.prism(8, 0.4, 0.36, 0.93, 1, Math.PI / 8);
  },
  // twin towers of unequal height
  (m, v) => {
    m.box(-H, -H, H, H, 0, 0.2);
    m.box(-0.46, -0.34, -0.08, 0.34, 0.2, 1);
    m.box(0.08, -0.34, 0.46, 0.34, 0.2, 0.78 + v * 0.06);
  },
  // office tower with rooftop plant
  (m, v) => {
    m.box(-0.45, -0.45, 0.45, 0.45, 0, 0.88 + v * 0.02);
    m.box(-0.26, -0.2, 0.1, 0.24, 0.88 + v * 0.02, 0.96);
    m.box(-0.08, -0.08, 0.08, 0.08, 0.96, 1);
  },
  // asymmetric stepped tower
  (m, v) => {
    const shift = 0.06 + v * 0.03;
    m.box(-H, -H, H, H, 0, 0.38);
    m.box(-H + shift, -H + shift, 0.38, 0.42, 0.38, 0.72);
    m.box(-H + shift * 2, -H + shift * 2, 0.16, 0.2, 0.72, 1);
  },
];

const HIGH: Builder[] = [
  // classic three-setback skyscraper
  (m, v) => {
    m.box(-H, -H, H, H, 0, 0.26 + v * 0.03);
    m.box(-0.4, -0.4, 0.4, 0.4, 0.26 + v * 0.03, 0.55);
    m.box(-0.3, -0.3, 0.3, 0.3, 0.55, 0.8);
    m.box(-0.19, -0.19, 0.19, 0.19, 0.8, 1);
  },
  // tapered tower
  (m, v) => {
    const top = 0.24 - v * 0.03;
    m.volumeBox([-H, -H, H, H], [-top, -top, top, top], 0, 0.94);
    m.box(-top + 0.03, -top + 0.03, top - 0.03, top - 0.03, 0.94, 1);
  },
  // tower + crown + spire
  (m, v) => {
    const w = 0.34 - v * 0.02;
    m.box(-H, -H, H, H, 0, 0.14);
    m.box(-w, -w, w, w, 0.14, 0.8);
    m.prism(8, w * 0.94, w * 0.6, 0.8, 0.93, Math.PI / 8);
    m.box(-0.045, -0.045, 0.045, 0.045, 0.93, 1);
  },
  // tower with a large mechanical cap
  (m, v) => {
    m.box(-0.42, -0.42, 0.42, 0.42, 0, 0.86 + v * 0.03);
    m.box(-0.3, -0.24, 0.18, 0.3, 0.86 + v * 0.03, 0.95);
    m.box(-0.04, -0.04, 0.04, 0.04, 0.95, 1);
  },
  // three volumes of different heights
  (m, v) => {
    m.box(-H, -H, H, H, 0, 0.16);
    m.box(-H, -0.4, -0.1, 0.4, 0.16, 1);
    m.box(-0.06, -0.34, 0.24, 0.34, 0.16, 0.76 + v * 0.05);
    m.box(0.28, -0.26, H, 0.26, 0.16, 0.52);
  },
  // central tower braced by corner buttresses
  (m, v) => {
    const b = 0.5 + v * 0.05;
    m.box(-0.22, -0.22, 0.22, 0.22, 0, 1);
    m.box(-H, -H, -0.24, -0.24, 0, b);
    m.box(0.24, -H, H, -0.24, 0, b * 0.86);
    m.box(-H, 0.24, -0.24, H, 0, b * 0.92);
    m.box(0.24, 0.24, H, H, 0, b * 0.78);
  },
  // narrow tower with a long antenna
  (m, v) => {
    const w = 0.26 - v * 0.02;
    m.box(-0.4, -0.4, 0.4, 0.4, 0, 0.12);
    m.box(-w, -w, w, w, 0.12, 0.88);
    m.box(-w * 0.7, -w * 0.7, w * 0.7, w * 0.7, 0.88, 0.94);
    m.box(-0.03, -0.03, 0.03, 0.03, 0.94, 1);
  },
];

const POOLS = [LOW, MID, HIGH];
const VARIANTS = 3;

export interface ArchetypeKit {
  /** every baked geometry, one InstancedMesh batch each */
  geometries: THREE.BufferGeometry[];
  /** batch index for a building, from its path and how tall it ends up */
  pick(pathHash: number, height: number): number;
  dispose(): void;
}

/** boundaries between the low, mid and high-rise pools, in world units */
const LOW_MAX = 3.6;
const MID_MAX = 9.5;

export function createArchetypeKit(): ArchetypeKit {
  const geometries: THREE.BufferGeometry[] = [];
  const offsets: number[] = [];

  for (const pool of POOLS) {
    offsets.push(geometries.length);
    for (const builder of pool) {
      for (let v = 0; v < VARIANTS; v++) {
        const mesher = new Mesher();
        builder(mesher, v);
        geometries.push(mesher.build());
      }
    }
  }

  return {
    geometries,

    pick(pathHash, height) {
      const tier = height < LOW_MAX ? 0 : height < MID_MAX ? 1 : 2;
      const pool = POOLS[tier];
      const shape = (pathHash >>> 3) % pool.length;
      const variant = (pathHash >>> 11) % VARIANTS;
      return offsets[tier] + shape * VARIANTS + variant;
    },

    dispose() {
      for (const g of geometries) g.dispose();
    },
  };
}

/** FNV-1a — the same hash the ingest uses, so shapes are stable across reloads. */
export function hashPath(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
