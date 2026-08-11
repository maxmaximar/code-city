import * as THREE from "three";

/**
 * Recency ramp: cold cyan for code nobody has touched in years, hot red for
 * what changed last week. Identical stops drive the CSS legend and the
 * timeline bars so the three readings agree. This mapping carries real data
 * and is never traded for a decorative one.
 */
const STOPS: Array<[number, number]> = [
  [0.0, 0x22c7d6],
  [0.16, 0x3fd2a2],
  [0.32, 0x63d66a],
  [0.44, 0xa9da4c],
  [0.56, 0xe3d23c],
  [0.76, 0xf0902b],
  [1.0, 0xe23b2b],
];

const cache = new Map<number, THREE.Color>();
const a = new THREE.Color();
const b = new THREE.Color();

export function rampColor(t: number, out = new THREE.Color()): THREE.Color {
  const x = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  let i = 0;
  while (i < STOPS.length - 2 && x > STOPS[i + 1][0]) i++;
  const [t0, c0] = STOPS[i];
  const [t1, c1] = STOPS[i + 1];
  const k = t1 === t0 ? 0 : (x - t0) / (t1 - t0);
  a.setHex(c0, THREE.SRGBColorSpace);
  b.setHex(c1, THREE.SRGBColorSpace);
  return out.copy(a).lerp(b, k);
}

/** Quantised lookup — thousands of buildings do not need distinct Color objects. */
export function rampColorCached(t: number): THREE.Color {
  const key = Math.round((Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0) * 255);
  let c = cache.get(key);
  if (!c) {
    c = rampColor(key / 255);
    cache.set(key, c);
  }
  return c;
}

export function rampCss(t: number): string {
  return `#${rampColor(t).getHexString()}`;
}

// ---------------------------------------------------------------------------
// shared uniforms — one object drives buildings, roads and conduits together,
// which is what makes the city read as a single powered system
// ---------------------------------------------------------------------------

export interface CityUniforms {
  uTime: { value: number };
  /** 0…1 construction sweep across the city */
  uBuild: { value: number };
  uFogColor: { value: THREE.Color };
  uFogDensity: { value: number };
  uCityHeight: { value: number };
  /** world units between illuminated floor bands */
  uFloor: { value: number };
  /** world units between vertical facade divisions */
  uMullion: { value: number };
  /** origin of the travelling city-wide pulse, in XZ */
  uWaveOrigin: { value: THREE.Vector2 };
  /** current radius of that pulse */
  uWaveRadius: { value: number };
  uWaveWidth: { value: number };
  /** district index to isolate, or -1 for the whole city */
  uIsolate: { value: number };
  /** radius the construction survey scan sweeps out to */
  uScanSpan: { value: number };
  /** distance at which facade detail starts fading out */
  uLodNear: { value: number };
  /** distance beyond which only the silhouette and its edges are drawn */
  uLodFar: { value: number };
  /** dev only: 0 normal · 1 core · 2 bands · 3 mullions · 4 corners · 5 fresnel · 6 crown+roof */
  uDebug: { value: number };
}

export function createCityUniforms(): CityUniforms {
  return {
    uTime: { value: 0 },
    uBuild: { value: 1 },
    uFogColor: { value: new THREE.Color(0x000000) },
    uFogDensity: { value: 0.004 },
    uCityHeight: { value: 20 },
    uFloor: { value: 0.62 },
    uMullion: { value: 0.085 },
    uWaveOrigin: { value: new THREE.Vector2() },
    uWaveRadius: { value: -1000 },
    uWaveWidth: { value: 14 },
    uIsolate: { value: -1 },
    uScanSpan: { value: 120 },
    uLodNear: { value: 90 },
    uLodFar: { value: 260 },
    uDebug: { value: 0 },
  };
}

const SHARED = /* glsl */ `
  uniform float uTime;
  uniform vec3  uFogColor;
  uniform float uFogDensity;
  uniform vec2  uWaveOrigin;
  uniform float uWaveRadius;
  uniform float uWaveWidth;
  uniform float uDebug;
  uniform float uBuild;
  uniform float uScanSpan;

  /**
   * The construction sequence, staged. Each layer of the city gets its own
   * slice of the same 0…1 progress, so the whole thing assembles in order
   * instead of appearing at once:
   *   0.00–0.16  ground scan
   *   0.10–0.30  block pads and outlines
   *   0.22–0.46  conduits draw themselves along their routes
   *   0.28–0.90  buildings rise
   *   0.88–1.00  crowns resolve and the energy comes on
   */
  float stage(float from, float to) {
    return smoothstep(from, to, uBuild);
  }

  float cityWave(vec2 p) {
    float d = distance(p, uWaveOrigin);
    return exp(-pow((d - uWaveRadius) / uWaveWidth, 2.0));
  }

  float hash11(float n) {
    return fract(sin(n * 12.9898) * 43758.5453);
  }

  vec3 applyFog(vec3 col, float depth) {
    float f = 1.0 - exp(-uFogDensity * uFogDensity * depth * depth);
    return mix(col, uFogColor, clamp(f, 0.0, 1.0));
  }
`;

// ---------------------------------------------------------------------------
// buildings
// ---------------------------------------------------------------------------

const BUILDING_VERT = /* glsl */ `
  attribute float aTrim;     // 0 at a volume's base, 1 at its top
  attribute float aEdge;     // 0 / 1 at a wall's vertical corners
  attribute float aVolume;   // which stacked volume this face belongs to
  attribute float aHeight;   // target world height
  attribute float aSeed;
  attribute float aDelay;
  attribute float aFocus;
  attribute float aDistrict;

  uniform float uIsolate;
  uniform float uLodNear;
  uniform float uLodFar;

  varying float vLod;
  varying vec3  vColor;
  varying vec3  vNormalW;
  varying vec3  vViewDirW;
  varying vec3  vWorldPos;
  varying float vHeight;
  varying float vLocalY;
  varying float vTrim;
  varying float vEdge;
  varying float vVolume;
  varying float vSeed;
  varying float vFocus;
  varying float vDim;
  varying float vGrow;
  varying float vFogDepth;

  void main() {
    float phase = clamp((uBuild - 0.28) / 0.62, 0.0, 1.0);
    float raw   = clamp((phase - aDelay) / 0.34, 0.0, 1.0);
    float grow  = raw * raw * (3.0 - 2.0 * raw);
    float h     = aHeight * grow;
    float alive = step(0.0005, h);

    // The kit is authored in a unit box, so height is a single multiply and the
    // building's proportions survive any scale.
    vec3 pos = vec3(position.x, position.y * h, position.z) * alive;

    vec4 local = vec4(pos, 1.0);
    #ifdef USE_INSTANCING
      local = instanceMatrix * local;
    #endif

    vec4 worldPosition = modelMatrix * local;
    vec4 mvPosition    = modelViewMatrix * local;

    vec3 objectNormal = normal;
    #ifdef USE_INSTANCING
      objectNormal = mat3(instanceMatrix) * objectNormal;
    #endif

    vColor = vec3(1.0);
    #ifdef USE_INSTANCING_COLOR
      vColor = instanceColor;
    #endif

    vNormalW  = normalize(mat3(modelMatrix) * objectNormal);
    vViewDirW = cameraPosition - worldPosition.xyz;
    vWorldPos = worldPosition.xyz;
    vHeight   = max(aHeight, 0.001);
    vLocalY   = position.y;
    vTrim     = aTrim;
    vEdge     = aEdge;
    vVolume   = aVolume;
    vSeed     = aSeed;
    vFocus    = aFocus;
    // isolation dims the rest of the city instead of deleting it, so a district
    // is always read in the context of the repository around it
    vDim      = (uIsolate >= 0.0 && abs(aDistrict - uIsolate) > 0.5) ? 1.0 : 0.0;
    vGrow     = grow;
    vFogDepth = -mvPosition.z;

    // Distance LOD, decided per vertex and carried to the fragment stage.
    // 0 = full facade · 1 = silhouette and edges only. Facade rulings that are
    // thinner than a pixel are pure aliasing, so the far tiers drop them and
    // get cheaper at exactly the distance where they stop being legible.
    vLod = smoothstep(uLodNear, uLodFar, vFogDepth);

    gl_Position = projectionMatrix * mvPosition;
  }
`;

const BUILDING_FRAG = /* glsl */ `
  precision highp float;

  uniform float uCityHeight;
  uniform float uFloor;
  uniform float uMullion;

  varying float vLod;
  varying vec3  vColor;
  varying vec3  vNormalW;
  varying vec3  vViewDirW;
  varying vec3  vWorldPos;
  varying float vHeight;
  varying float vLocalY;
  varying float vTrim;
  varying float vEdge;
  varying float vVolume;
  varying float vSeed;
  varying float vFocus;
  varying float vDim;
  varying float vGrow;
  varying float vFogDepth;

  // Two fixed directions so opposite walls never read at the same brightness —
  // that contrast is most of what makes a box look like architecture.
  const vec3 KEY  = vec3(0.4104, 0.8898, 0.2018);
  const vec3 FILL = vec3(-0.5883, 0.2451, -0.6863);

  // anti-aliased line at every integer of x, fading out once it would alias
  float ruling(float x, float sharpness) {
    float w = fwidth(x);
    float e = min(fract(x), 1.0 - fract(x));
    float line = 1.0 - smoothstep(0.0, max(w * sharpness, 0.008), e);
    return line * (1.0 - smoothstep(0.16, 0.46, w));
  }

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDirW);

    float key  = max(dot(N, KEY), 0.0);
    float fill = max(dot(N, FILL), 0.0);
    float face = 0.07 + 0.5 * key + 0.2 * fill;

    float roof = smoothstep(0.55, 0.88, abs(N.y));
    float wall = 1.0 - roof;
    float up   = clamp(vWorldPos.y / max(vHeight, 0.001), 0.0, 1.0);

    // ── facade ─────────────────────────────────────────────────────────────
    // LOD 1 keeps the silhouette, the corners and the crowns and drops the
    // per-storey work entirely; at that distance a floor band is under a pixel.
    float detail = 1.0 - vLod;
    float bands = 0.0;
    float mullions = 0.0;
    float litFloor = 0.0;

    if (detail > 0.02) {
      // Floor bands are world-space so storeys line up across the whole city.
      float floors = vWorldPos.y / uFloor;
      bands = ruling(floors, 0.9) * wall * detail;

      // Vertical divisions run along whichever axis the wall faces.
      float ax = abs(N.x);
      float az = abs(N.z);
      float across = (ax * vWorldPos.z + az * vWorldPos.x) / max(ax + az, 1e-4);
      mullions = ruling(across / uMullion, 1.1) * wall * detail;

      // A few storeys per building are lit; the rest of the facade stays dark.
      litFloor = step(0.87, hash11(floor(floors) * 7.13 + vSeed * 91.7));
    }

    // Corner lines and the top edge of every stacked volume — this is where a
    // low-poly mass starts reading as architecture. The width is clamped and
    // faded: on a building only a few pixels wide an unclamped corner line
    // would swallow the whole facade.
    float ew = fwidth(vEdge);
    float corner = (1.0 - smoothstep(0.0, clamp(ew * 1.2, 0.014, 0.05), min(vEdge, 1.0 - vEdge)))
                 * wall * (1.0 - smoothstep(0.12, 0.4, ew));
    float trimLine = smoothstep(0.9, 1.0, vTrim) * wall;
    // Crown lighting belongs on the last few metres of facade, not spread flat
    // across every roof slab — those are the surfaces the camera sees most of.
    float crown = smoothstep(0.93, 1.0, vLocalY) * (0.2 + 0.8 * wall);

    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.5);

    // ── energy ─────────────────────────────────────────────────────────────
    float cycle   = uTime * 0.19 + vSeed;
    float charged = step(0.66, fract(vSeed * 37.7 + floor(cycle)));
    float pulseY  = fract(cycle) * vHeight;
    float pulse   = exp(-pow((vWorldPos.y - pulseY) / (0.5 + vHeight * 0.045), 2.0)) * charged;

    float wave    = cityWave(vWorldPos.xz);
    float breathe = 0.9 + 0.1 * sin(uTime * 0.9 + vSeed * 6.2831);
    float energy  = 1.0 + wave * 1.35 + vFocus * 1.4;

    // ── assembly: dark core, energy on the edges ───────────────────────────
    // The wall itself stays close to black. Everything that reads as a building
    // is a line on it — floor bands, mullions, corners, roof trims — so the city
    // is drawn rather than lit.
    vec3 hue  = vColor;
    // sRGB encoding lifts dark values hard — a linear 0.03 already reads as
    // ~19% on screen — so a wall that should look near-black has to sit an
    // order of magnitude below what the number suggests.
    vec3 core = hue * face * (0.028 + 0.012 * vVolume);

    float lift = 0.8 + 0.3 * up + 0.12 * clamp(vHeight / max(uCityHeight, 1.0), 0.0, 1.0);

    vec3 glow = hue * (
        bands    * (0.14 + 0.5 * litFloor)
      + mullions * 0.09
      + corner   * 0.44
      + trimLine * 0.6
      + roof     * 0.035
      + crown    * (0.2 + 0.4 * wave)
      + fres     * 0.45
      + pulse    * 1.1
    ) * breathe * lift * energy;

    vec3 col = core + glow;

    // white-hot only where the energy genuinely peaks
    float hot = max(max(trimLine, corner * 0.9), max(fres, pulse * 0.8));
    col += vec3(pow(hot, 5.0)) * 0.3;

    // the rising cap during construction
    float building = step(0.001, vGrow) * (1.0 - vGrow);
    col += hue * building * 2.0 * (1.0 - smoothstep(0.0, 0.6, abs(vWorldPos.y - vGrow * vHeight)));

    col = mix(col, col * 2.1 + hue * 0.3, vFocus);
    col = mix(col, col * 0.12 + vec3(0.004, 0.007, 0.009), vDim * 0.9);
    col = applyFog(col, vFogDepth);

    if (uDebug > 0.5) {
      float d = uDebug;
      float term =
          d < 1.5 ? face * (0.028 + 0.012 * vVolume)
        : d < 2.5 ? bands * (0.16 + 0.55 * litFloor)
        : d < 3.5 ? mullions * 0.10
        : d < 4.5 ? corner * 0.62
        : d < 5.5 ? fres * 0.82
        : (crown * 0.4 + roof * 0.13);
      col = vec3(term);
    }

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export function buildingMaterial(uniforms: CityUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: `${SHARED}\n${BUILDING_VERT}`,
    fragmentShader: `${SHARED}\n${BUILDING_FRAG}`,
  });
}

// ---------------------------------------------------------------------------
// ground: district plates and block pads
// ---------------------------------------------------------------------------

const GROUND_VERT = /* glsl */ `
  attribute float aKind;   // 0 district plate · 1 block pad
  varying vec3  vWorldPos;
  varying float vKind;
  varying float vFogDepth;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec4 mv    = modelViewMatrix * vec4(position, 1.0);
    vWorldPos  = world.xyz;
    vKind      = aKind;
    vFogDepth  = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const GROUND_FRAG = /* glsl */ `
  precision highp float;
  varying vec3  vWorldPos;
  varying float vKind;
  varying float vFogDepth;

  void main() {
    // Near-black either way. A district plate is the street surface, a block pad
    // the paved lot inside it — just enough separation for the gap between pads
    // to read as a street without ever lighting up the ground.
    vec3 base = mix(vec3(0.0045, 0.0075, 0.0092), vec3(0.0085, 0.0130, 0.0152), vKind);

    // faint service grid, on the streets only
    float g = min(
      abs(fract(vWorldPos.x * 0.25) - 0.5),
      abs(fract(vWorldPos.z * 0.25) - 0.5)
    );
    float grid = (1.0 - smoothstep(0.0, 0.03, g)) * (1.0 - vKind);

    // staged reveal: the street surface first, then the block pads on top
    float reveal = mix(stage(0.0, 0.16), stage(0.10, 0.30), vKind);

    vec3 col = base
      + vec3(0.003, 0.010, 0.013) * grid
      + cityWave(vWorldPos.xz) * vec3(0.010, 0.040, 0.052);
    col *= reveal;

    // the survey scan that runs ahead of everything else
    float scanR = uBuild * uScanSpan;
    float scan = exp(-pow((length(vWorldPos.xz - uWaveOrigin) - scanR) / (uScanSpan * 0.035), 2.0));
    col += vec3(0.06, 0.30, 0.38) * scan * (1.0 - stage(0.18, 0.34));

    gl_FragColor = vec4(applyFog(col, vFogDepth), 1.0);
    #include <colorspace_fragment>
  }
`;

export function groundMaterial(uniforms: CityUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: GROUND_VERT,
    fragmentShader: `${SHARED}\n${GROUND_FRAG}`,
  });
}

// ---------------------------------------------------------------------------
// energy conduits
// ---------------------------------------------------------------------------

const CONDUIT_VERT = /* glsl */ `
  attribute float aAlong;   // metres travelled along this route
  attribute float aLength;  // total route length
  attribute float aSide;    // −1 / +1 across the strip
  attribute float aRoute;   // stable per-route seed
  attribute vec3  aTint;

  varying float vAlong;
  varying float vLength;
  varying float vSide;
  varying float vRoute;
  varying vec3  vTint;
  varying vec3  vWorldPos;
  varying float vFogDepth;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec4 mv    = modelViewMatrix * vec4(position, 1.0);
    vAlong    = aAlong;
    vLength   = aLength;
    vSide     = aSide;
    vRoute    = aRoute;
    vTint     = aTint;
    vWorldPos = world.xyz;
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const CONDUIT_FRAG = /* glsl */ `
  precision highp float;

  varying float vAlong;
  varying float vLength;
  varying float vSide;
  varying float vRoute;
  varying vec3  vTint;
  varying vec3  vWorldPos;
  varying float vFogDepth;

  void main() {
    // soft edge across the strip so the conduit reads as light, not a ribbon
    float across = 1.0 - smoothstep(0.35, 1.0, abs(vSide));
    float base   = 0.075 * across;

    // Packets: three per route, evenly offset, travelling at a route-specific
    // speed. All of it is a function of time — no geometry is ever rebuilt.
    float packet = 0.0;
    for (int i = 0; i < 3; i++) {
      float phase = fract(uTime * (0.055 + vRoute * 0.05) + vRoute + float(i) * 0.333);
      float head  = phase * vLength;
      float d     = vAlong - head;
      // a short bright head with a tail dragging behind it
      packet += exp(-pow(d / 0.6, 2.0)) + 0.35 * exp(-pow(max(-d, 0.0) / 3.2, 2.0));
    }

    // the route assembles from its start, then powers up
    float drawn = stage(0.22, 0.46) * vLength;
    if (vAlong > drawn) discard;
    float tip = exp(-pow((vAlong - drawn) / 1.4, 2.0)) * (1.0 - stage(0.44, 0.56));

    float wave = cityWave(vWorldPos.xz);
    float glow = (base + packet * across * 0.9 + wave * across * 0.7) * stage(0.24, 0.5)
               + tip * across * 1.6;

    vec3 col = vTint * glow;
    col += vec3(pow(clamp(packet * across, 0.0, 1.5), 3.0)) * 0.35;

    gl_FragColor = vec4(applyFog(col, vFogDepth), clamp(glow * 2.4, 0.0, 1.0));
    #include <colorspace_fragment>
  }
`;

export function conduitMaterial(uniforms: CityUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: CONDUIT_VERT,
    fragmentShader: `${SHARED}\n${CONDUIT_FRAG}`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

// ---------------------------------------------------------------------------
// junction nodes
// ---------------------------------------------------------------------------

const NODE_VERT = /* glsl */ `
  attribute vec3  aCentre;
  attribute float aScale;
  attribute float aSeed;
  attribute vec3  aTint;

  varying vec2  vUv;
  varying float vSeed;
  varying vec3  vTint;
  varying vec3  vWorldPos;
  varying float vFogDepth;

  void main() {
    vUv = position.xz * 2.0;
    vSeed = aSeed;
    vTint = aTint;

    vec3 world = aCentre + vec3(position.x, 0.0, position.z) * aScale;
    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    vWorldPos = world;
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const NODE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2  vUv;
  varying float vSeed;
  varying vec3  vTint;
  varying vec3  vWorldPos;
  varying float vFogDepth;

  void main() {
    float r = length(vUv);
    if (r > 1.0) discard;
    float core = exp(-pow(r / 0.22, 2.0));
    float ring = exp(-pow((r - 0.62) / 0.1, 2.0));
    float beat = 0.45 + 0.55 * pow(fract(uTime * 0.22 + vSeed), 6.0);
    float wave = cityWave(vWorldPos.xz);
    float i = (core * 1.1 + ring * 0.4) * (beat + wave * 1.2) * stage(0.34, 0.56);
    gl_FragColor = vec4(applyFog(vTint * i, vFogDepth), clamp(i, 0.0, 1.0));
    #include <colorspace_fragment>
  }
`;

export function nodeMaterial(uniforms: CityUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: NODE_VERT,
    fragmentShader: `${SHARED}\n${NODE_FRAG}`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
