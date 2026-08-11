import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/** azimuth, in radians, that puts the district grid on the diagonal */
const THETA = 0.7;
/** polar angle from +Y — ~27° of elevation, the reference's aerial angle */
const PHI = 1.17;
/** fraction of the frame the city should fill on each axis */
const FILL_X = 1.04;
const FILL_Y = 1.02;

/** one revolution takes minutes: presence, not motion */
const DRIFT_SPEED = 0.09;
const DRIFT_RESUME_MS = 3500;

export interface CameraRig {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  frame(bounds: THREE.Box3): void;
  resize(width: number, height: number): void;
  azimuth(): number;
  /** slow idle drift; pauses while the user is driving */
  setDrift(on: boolean): void;
  /** scripted flythrough pose, `t` running 0…1 alongside the timeline */
  applyFlythrough(t: number): void;
  /** ease back to the framed default */
  returnHome(): void;
  /** smoothly bring a world point into view at roughly `radius` of framing */
  flyTo(point: THREE.Vector3, radius: number): void;
  /** the framed overview distance, for callers sizing their own fly-to */
  homeDistance(): number;
  update(dt: number): void;
  topView(on: boolean): void;
  isTopView(): boolean;
  dispose(): void;
}

interface Pose {
  theta: number;
  phi: number;
  distance: number;
  targetY: number;
}

export function createCameraRig(canvas: HTMLCanvasElement): CameraRig {
  const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 4000);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  // Damping keeps the inertia; the speeds do not. Crossing a 400-unit
  // metropolis and dropping into one district has to take a flick of the wrist,
  // not a minute of dragging.
  controls.dampingFactor = 0.12;
  controls.rotateSpeed = 1.4;
  controls.zoomSpeed = 2.6;
  controls.panSpeed = 2.4;
  // zoom toward the cursor: on a large city, zooming to the screen centre means
  // constantly re-panning to whatever you were actually looking at
  controls.zoomToCursor = true;
  controls.screenSpacePanning = false;
  controls.minPolarAngle = 0.05;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.autoRotateSpeed = DRIFT_SPEED;

  const centre = new THREE.Vector3();
  const homeCentre = new THREE.Vector3();
  const base: Pose = { theta: THETA, phi: PHI, distance: 100, targetY: 0 };

  let driftWanted = true;
  let lastInput = 0;
  let scripted: Pose | null = null;
  let focus: { target: THREE.Vector3; pose: Pose } | null = null;
  let homing = 0;
  let top = false;

  const markInput = () => {
    lastInput = performance.now();
    controls.autoRotate = false;
    scripted = null;
    focus = null;
    homing = 0;
  };
  controls.addEventListener("start", markInput);
  canvas.addEventListener("wheel", markInput, { passive: true });

  function place(pose: Pose): void {
    const offset = new THREE.Vector3().setFromSphericalCoords(pose.distance, pose.phi, pose.theta);
    controls.target.set(centre.x, pose.targetY, centre.z);
    camera.position.copy(controls.target).add(offset);
    camera.near = Math.max(0.5, pose.distance * 0.02);
    camera.far = pose.distance * 8;
    camera.updateProjectionMatrix();
    camera.lookAt(controls.target);
  }

  function currentPose(): Pose {
    const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
    const s = new THREE.Spherical().setFromVector3(offset);
    return { theta: s.theta, phi: s.phi, distance: s.radius, targetY: controls.target.y };
  }

  return {
    camera,
    controls,

    frame(bounds) {
      const size = new THREE.Vector3();
      bounds.getSize(size);
      bounds.getCenter(centre);
      homeCentre.copy(centre);
      const targetY = bounds.max.y * 0.3;

      // The city is a rotated square seen at an angle, so a radius-based fit
      // wastes most of the frame. Project the real corners and shrink until the
      // widest one lands on the target fill.
      const corners: THREE.Vector3[] = [];
      for (const x of [bounds.min.x, bounds.max.x]) {
        for (const y of [0, bounds.max.y]) {
          for (const z of [bounds.min.z, bounds.max.z]) {
            corners.push(new THREE.Vector3(x, y, z));
          }
        }
      }

      const probe = new THREE.Vector3();
      let distance = Math.max(size.x, size.z, size.y) * 2.2;

      for (let iteration = 0; iteration < 5; iteration++) {
        place({ theta: THETA, phi: PHI, distance, targetY });
        camera.updateMatrixWorld(true);
        let mx = 1e-6;
        let my = 1e-6;
        for (const corner of corners) {
          probe.copy(corner).project(camera);
          mx = Math.max(mx, Math.abs(probe.x));
          my = Math.max(my, Math.abs(probe.y));
        }
        distance *= Math.max(mx / FILL_X, my / FILL_Y);
      }

      base.theta = THETA;
      base.phi = PHI;
      base.distance = distance;
      base.targetY = targetY;
      place(base);

      controls.minDistance = distance * 0.02;
      controls.maxDistance = distance * 3.4;
      controls.update();
    },

    resize(width, height) {
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
    },

    azimuth() {
      const dx = camera.position.x - controls.target.x;
      const dz = camera.position.z - controls.target.z;
      return (Math.atan2(dx, dz) * 180) / Math.PI;
    },

    setDrift(on) {
      driftWanted = on;
      if (!on) controls.autoRotate = false;
    },

    applyFlythrough(t) {
      const e = Math.min(1, Math.max(0, t));
      // start low and close on the young city, pull up and back as it grows
      const ease = e * e * (3 - 2 * e);
      scripted = {
        theta: base.theta - 0.55 + ease * 1.05,
        phi: THREE.MathUtils.lerp(1.42, base.phi, ease),
        distance: base.distance * THREE.MathUtils.lerp(0.42, 1.0, Math.pow(ease, 0.75)),
        targetY: base.targetY * THREE.MathUtils.lerp(0.25, 1, ease),
      };
      controls.autoRotate = false;
      homing = 0;
    },

    returnHome() {
      scripted = null;
      focus = null;
      homing = 1;
    },

    flyTo(point, radius) {
      // Keep the current viewing angle and only change what is being looked at,
      // so a jump to a search result never disorients.
      const now = currentPose();
      scripted = null;
      homing = 0;
      focus = {
        target: point.clone(),
        pose: {
          theta: now.theta,
          phi: Math.min(Math.max(now.phi, 0.55), 1.25),
          distance: Math.max(6, radius * 2.4),
          targetY: point.y,
        },
      };
      lastInput = 0;
      controls.autoRotate = false;
    },

    homeDistance: () => base.distance,

    topView(on) {
      top = on;
      scripted = null;
      homing = 1;
    },

    isTopView: () => top,

    update(dt) {
      if (focus) {
        const now = currentPose();
        const k = 1 - Math.exp(-3.6 * Math.min(dt, 0.1));
        centre.lerp(focus.target, k);
        place({
          theta: now.theta + (focus.pose.theta - now.theta) * k,
          phi: now.phi + (focus.pose.phi - now.phi) * k,
          distance: now.distance + (focus.pose.distance - now.distance) * k,
          targetY: now.targetY + (focus.pose.targetY - now.targetY) * k,
        });
        if (
          centre.distanceTo(focus.target) < 0.4 &&
          Math.abs(now.distance - focus.pose.distance) < focus.pose.distance * 0.02
        ) {
          focus = null;
        }
      } else if (scripted) {
        const now = currentPose();
        const k = 1 - Math.exp(-6 * Math.min(dt, 0.1));
        place({
          theta: now.theta + (scripted.theta - now.theta) * k,
          phi: now.phi + (scripted.phi - now.phi) * k,
          distance: now.distance + (scripted.distance - now.distance) * k,
          targetY: now.targetY + (scripted.targetY - now.targetY) * k,
        });
      } else if (homing > 0) {
        centre.lerp(homeCentre, 1 - Math.exp(-5 * Math.min(dt, 0.1)));
        const now = currentPose();
        const goal: Pose = top
          ? { theta: base.theta, phi: 0.08, distance: base.distance * 0.86, targetY: 0 }
          : base;
        const k = 1 - Math.exp(-5 * Math.min(dt, 0.1));
        const next = {
          theta: now.theta + (goal.theta - now.theta) * k,
          phi: now.phi + (goal.phi - now.phi) * k,
          distance: now.distance + (goal.distance - now.distance) * k,
          targetY: now.targetY + (goal.targetY - now.targetY) * k,
        };
        place(next);
        if (
          Math.abs(next.theta - goal.theta) < 0.002 &&
          Math.abs(next.phi - goal.phi) < 0.002 &&
          Math.abs(next.distance - goal.distance) < goal.distance * 0.002
        ) {
          homing = 0;
        }
      } else if (driftWanted && !controls.autoRotate && performance.now() - lastInput > DRIFT_RESUME_MS) {
        controls.autoRotate = true;
      }

      controls.update(dt);
    },

    dispose() {
      controls.removeEventListener("start", markInput);
      canvas.removeEventListener("wheel", markInput);
      controls.dispose();
    },
  };
}
