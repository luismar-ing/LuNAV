/**
 * The single WebGL context of the app (spec 8.7, rule 7). One three.js renderer is created the first time the
 * live view opens and then reused: leaving the live view only detaches its canvas and stops the loop, it never
 * disposes the context, so toggling modes can never pile up contexts (browsers cap them at ~16).
 *
 * This module imports three.js statically and is itself loaded with a dynamic import (SceneHost), so three.js
 * lands in its own chunk and the 2D shell does not download it.
 */
import * as THREE from "three";
import type { SceneEphemeris, Trajectory } from "../lib/contract";
import { parseInstant } from "../lib/contract";
import { phaseAt, type MissionTimeline } from "../lib/mission";
import { STRINGS } from "../lib/strings";
import { COLORS } from "../styles/tokens";
import { createBodies, loadTextures, updateBodies } from "./bodies";
import { approachPose, CameraController, directorPose, FOLLOW_WINDOWS, fromFrame, hopPose, localBlend, planningPose, reducedMotionPose, switchEase, toFrame, transitPose, type BodyFrame, type DirectorInput, type Pose } from "./cameraDirector";
import { conjugate, indexEphemeris, rotate, sceneStateAt, type SceneState } from "./ephemeris";
import { launchPositionKm, launchStage, padPositionKm, padUp, plumeIntensity, stagingAt } from "./launch";
import { apparentLength, createPlume, createRocket, ROCKET_SCREEN_FRACTION, setPlume, setStaging } from "./rocket";
import { bodyRadius, EARTH_RADII_KM, MOON_RADIUS_KM, earthOffset, drawnMoonCentre, pointToScene, RelativeOrigin, rocketScenePoint, SPACE_SCALE, toScene, type Vec3 } from "./scale";
import { siteBodyFixedKm, sitePositionKm, trailSamples, trailStyle } from "./trajectory";
import { TerrainManager, type TerrainData } from "./terrain";
import type { PlanSpec } from "./bridge";
import { createSkyOverlay, dirOf, type Enu } from "./skyOverlay";
import { createPolarMap, polarMapOpacity } from "./polarMap";
import { H_OBS_M, skyAzEl } from "./terrainLevelB";
import { enuBasis } from "./terrain";
import { CameraMotion, wheelZoom } from "./cameraInput";

/** The part of THREE.WebGLRenderer the manager uses (lets tests run without WebGL). */
export interface RendererLike {
  domElement: HTMLCanvasElement;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  setPixelRatio(ratio: number): void;
  setAnimationLoop(callback: XRFrameRequestCallback | null): void;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
}

export interface RendererManager<R extends RendererLike> {
  /** Returns the one renderer (created on first use) with its canvas attached to `container`. */
  acquire(container: HTMLElement): R;
  /** Stops the loop and detaches the canvas; the context stays alive for the next acquire. */
  release(): void;
  /** How many renderers were ever created (must stay ≤ 1). */
  readonly created: number;
  readonly current: R | null;
}

export function createRendererManager<R extends RendererLike>(factory: () => R): RendererManager<R> {
  let renderer: R | null = null;
  let created = 0;
  return {
    acquire(container) {
      if (!renderer) {
        renderer = factory();
        created++;
      }
      if (renderer.domElement.parentElement !== container) container.appendChild(renderer.domElement);
      return renderer;
    },
    release() {
      if (!renderer) return;
      renderer.setAnimationLoop(null);
      renderer.domElement.remove();
    },
    get created() {
      return created;
    },
    get current() {
      return renderer;
    },
  };
}

function createWebGLRenderer(): THREE.WebGLRenderer {
  // logarithmic depth buffer (spec 5.9): depth precision from metres at the site to Earth–Moon distance
  const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", logarithmicDepthBuffer: true });
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.setClearColor(COLORS.bg, 1);
  r.domElement.dataset.webgl = "poleplanner"; // lets the browser checks find the one canvas
  r.domElement.className = "scene-canvas";
  return r;
}

/** The app-wide manager (one per page). */
export const rendererManager = createRendererManager(createWebGLRenderer);

/** Near/far planes in scene units (1 unit = 1000 km): 1 mm to 10 million km, usable thanks to the log depth. */
export const CAMERA_NEAR = 1e-6;
export const CAMERA_FAR = 1e7;

export interface SceneHandle {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Camera-relative rendering: world positions (float64) are placed at `world − origin` each frame. */
  origin: RelativeOrigin;
  /** World positions of the scene objects (float64); the render loop turns them into camera-relative ones. */
  world: Map<THREE.Object3D, [number, number, number]>;
  /** Camera position in world units (float64); the THREE camera itself stays at the origin. */
  cameraWorld: [number, number, number];
}

/** Each frame: the camera becomes the origin, objects move to their camera-relative positions. */
export function applyCameraRelative(h: SceneHandle): void {
  h.origin.setOrigin(h.cameraWorld);
  h.camera.position.set(0, 0, 0);
  for (const [obj, p] of h.world) {
    const [x, y, z] = h.origin.relative(p);
    obj.position.set(x, y, z);
  }
}

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(...a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

export interface MountOptions {
  eph: SceneEphemeris;
  /** missionTime (epoch ms, UTC), read every frame. */
  getTimeMs(): number;
  /** Base URL of the static files (import.meta.env.BASE_URL). */
  baseUrl: string;
  /** Trajectory of the selected plan (launch, ascent and flight of the rocket); null hides the rocket. */
  trajectory: Trajectory | null;
  /** Mission timeline of the plan (drives the camera director); null keeps the transit framing. */
  timeline: MissionTimeline | null;
  /** Called when the user takes the camera ("manual") or gives it back ("director"). */
  onCameraModeChange?(mode: "director" | "manual"): void;
  /** Called when the scene switches between space scale (bodies ×6) and real local scale (λ ≥ 0.5). */
  onScaleChange?(scale: "space" | "local"): void;
  /** Site id and terrain loader (T4.3.b), called by distance during the final approach only. */
  siteId?: string;
  loadTerrain?(siteId: string, lod: number): Promise<TerrainData>;
  /** Reduced motion (the app setting, which starts from prefers-reduced-motion): fixed framings, no flights. */
  reducedMotion?(): boolean;
  /**
   * Read every frame. While true (Mission Planner before launch, A2) the camera frames the whole Earth
   * (planningPose) and dragging turns the globe; when it turns false ("Launch") the camera hops to the
   * mission's framing in real time, like a change of plan.
   */
  planning?(): boolean;
  /** Read every frame: Level B at the site (sunlight shadows from the terrain, T6.1). Off = the MVP scene. */
  levelB?(): boolean;
  /** Read every frame: stand on the site (first-person sky view at h_obs, TR.3.a). Needs Level B and the site. */
  surface?(): boolean;
  /** Read every frame: detailed launch (T6.3.a): staging. Off or absent = the MVP rocket. */
  detailedLaunch?(): boolean;
  /** Read every frame: the lit polar map as a step of the zoom (T6.2.b). Off or absent = the MVP zoom. */
  polarMap?(): boolean;
  /** Called when the polar map appears or goes (the UI shows its legend meanwhile). */
  onPolarMapVisible?(visible: boolean): void;
}

/** Surface view (TR.3.a): field of view limits (deg) and the initial gaze, a little below the horizon so the
 *  skyline sits in the upper half of the screen, above the site console. */
const SURFACE_FOV = { initial: 60, min: 15, max: 100 } as const;
const SURFACE_LOOK_EL = -8;

/** Sunlight shadows at the site (T6.1.b): an orthographic box ±SHADOW_HALF across, SHADOW_DEPTH long towards
 *  the Sun, so ridges as far as the 2D horizon mask looks (100 km) shade the ground around the site. */
const SHADOW_HALF = 10 / 1000; // 10 km in scene units
const SHADOW_DEPTH = 130 / 1000;
/** Mission time the Sun may move (relative to the ground) before the shadow map is redrawn. */
const SHADOW_REDRAW_MS = 60_000;

/** A9: the lander turns from its flight attitude to upright over the powered descent (its last 12 minutes). */
const DESCENT_UPRIGHT_MS = 12 * 60_000;
const smoothstep01 = (x: number) => {
  const u = Math.min(1, Math.max(0, x));
  return u * u * (3 - 2 * u);
};

/** Real size of the rocket at the site, drawn at real local scale (λ = 1): ~100 m, a generic launcher. */
export const ROCKET_REAL_LENGTH_UNITS = 100 / 1e6;
/** At real local scale the smooth Moon sphere is drawn this much below the reference radius, so the deepest
 *  polar craters of the terrain (a few km below it) are not cut by the sphere. */
const MOON_SPHERE_DROP_KM = 8;

export interface SceneControl {
  unmount(): void;
  /** Gives the camera back to the director (guided camera). */
  resumeCamera(): void;
  /**
   * Switches to another plan without leaving live mode (T4.4.b): same renderer and scene; the plan's trail,
   * site and terrain are rebuilt and the camera hops from its current view to the new plan's (SWITCH_MS).
   * Call it in the same task as the missionTime change of the new plan.
   */
  setPlan(p: PlanSpec): void;
}

/**
 * Mounts the live scene into `container`: the Earth, the Moon, the Sun and the stars at missionTime (T4.1.c),
 * the rocket, its launch and its trail (T4.2), and the camera director with user take-over (T4.3.a), on the
 * single renderer (T4.1.a) with camera-relative rendering (T4.1.b).
 */
export function mountScene(container: HTMLElement, opts: MountOptions): SceneControl {
  const renderer = rendererManager.acquire(container);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, CAMERA_NEAR, CAMERA_FAR);
  const handle: SceneHandle = { scene, camera, origin: new RelativeOrigin(), world: new Map(), cameraWorld: [0, 0, 10] };
  const ix = indexEphemeris(opts.eph);
  const bodies = createBodies(scene);
  loadTextures(bodies, opts.baseUrl, renderer instanceof THREE.WebGLRenderer ? renderer.capabilities.maxTextureSize : 4096);
  const rocket = createRocket();
  const plume = createPlume();
  rocket.add(plume);
  const pad = new THREE.Sprite(new THREE.SpriteMaterial({ color: COLORS.accent, sizeAttenuation: false, depthTest: false }));
  pad.name = "launch-pad";
  pad.scale.set(0.012, 0.012, 1);
  scene.add(rocket, pad);

  // sunlight shadows (Level B): set up once; drawn only at the site and only when the Sun or the ground changed
  const webgl = renderer instanceof THREE.WebGLRenderer ? renderer : null;
  if (webgl) {
    webgl.shadowMap.enabled = true;
    webgl.shadowMap.type = THREE.PCFShadowMap;
    webgl.shadowMap.autoUpdate = false;
  }
  const sh = bodies.sunLight.shadow;
  sh.mapSize.set(2048, 2048);
  Object.assign(sh.camera, { left: -SHADOW_HALF, right: SHADOW_HALF, top: SHADOW_HALF, bottom: -SHADOW_HALF, near: 0, far: SHADOW_DEPTH + SHADOW_HALF });
  sh.camera.updateProjectionMatrix();
  sh.bias = -0.00005;
  sh.normalBias = 0.00003; // 30 m: about one cell of the finest terrain, against shadow acne under a grazing Sun
  let shadowAt = { t: Number.NaN, version: -1 };

  const earthR = bodyRadius(EARTH_RADII_KM.equatorial);
  const moonR = bodyRadius(MOON_RADIUS_KM);
  // lit polar map (T6.2.b): a child of the Moon mesh, so it follows the Moon's place, turn and scale
  const polarMap = createPolarMap(opts.baseUrl, moonR);
  bodies.moon.add(polarMap);
  let polarMapShown = false;

  /**
   * Everything that depends on the plan: its trajectory, timeline, trail, site and terrain. Built at mount and
   * rebuilt in place when the plan changes in live mode (T4.4.b): same renderer, scene, bodies and camera.
   */
  interface PlanRig {
    traj: Trajectory | null;
    tl: MissionTimeline | null;
    trail: ReturnType<typeof trailSamples> | null;
    /** the Moon at each trail sample (A9: the arrival part of the trail is drawn riding with the Moon) */
    trailMoon: { km: Vec3; quat: [number, number, number, number] }[] | null;
    lunarArrivalMs: number;
    style: ReturnType<typeof trailStyle> | null;
    flown: THREE.Line;
    ahead: THREE.Line;
    landingMs: number;
    injectionMs: number;
    padUpAtLaunch: Vec3;
    siteBody: Vec3 | null;
    siteRadiusUnits: number; // R + site elevation, real scale
    terrain: TerrainManager | null;
  }

  const buildRig = (p: PlanSpec): PlanRig => {
    const traj = p.trajectory;
    // denser than before (A9): the low orbits round the Moon are drawn as smooth loops
    const trail = traj ? trailSamples(traj, 2400) : null;
    const style = traj ? trailStyle(traj.mode) : null;
    // trail (T4.2.c): flown part in light text, remaining part in medium grey; dashed if ILLUSTRATIVE (rule 2)
    const makeLine = (color: string, name: string) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(((trail?.km.length ?? 0) + 1) * 3), 3));
      const mat = style?.dashed
        ? new THREE.LineDashedMaterial({ color, dashSize: 2.5, gapSize: 1.8, transparent: true, opacity: 0.9 })
        : new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
      const line = new THREE.Line(geo, mat);
      line.name = name;
      line.frustumCulled = false;
      scene.add(line);
      handle.world.set(line, [0, 0, 0]); // geometry in world units; the object follows the camera-relative origin
      return line;
    };
    const launchMs = traj ? parseInstant(traj.phases.launch_utc) : ix.startMs;
    const siteBody = traj ? siteBodyFixedKm(traj, ix) : null;
    // terrain at real local scale (T4.3.b): loaded by distance during the final approach, never before
    const terrain = siteBody && p.siteId && opts.loadTerrain ? new TerrainManager(p.siteId, siteBody, opts.loadTerrain) : null;
    if (terrain) scene.add(terrain.group);
    rocket.visible = pad.visible = traj !== null;
    return {
      traj,
      tl: p.timeline,
      trail,
      trailMoon: trail
        ? trail.tMs.map((tt) => {
            const s = sceneStateAt(ix, tt);
            return { km: s.moonKm, quat: s.moonQuat };
          })
        : null,
      lunarArrivalMs: traj ? parseInstant(traj.phases.lunar_arrival_utc) : Number.POSITIVE_INFINITY,
      style,
      flown: makeLine(COLORS.text, "trail-flown"),
      ahead: makeLine(COLORS.borderStrong, "trail-ahead"),
      landingMs: traj ? parseInstant(traj.phases.landing_utc) : Number.POSITIVE_INFINITY,
      injectionMs: traj ? parseInstant(traj.phases.injection_utc) : Number.NEGATIVE_INFINITY,
      padUpAtLaunch: padUp(sceneStateAt(ix, launchMs).earthQuat),
      siteBody,
      siteRadiusUnits: siteBody ? Math.hypot(...siteBody) / 1000 : 0,
      terrain,
    };
  };

  const disposeRig = (r: PlanRig) => {
    for (const line of [r.flown, r.ahead]) {
      scene.remove(line);
      handle.world.delete(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    if (r.terrain) {
      scene.remove(r.terrain.group);
      handle.world.delete(r.terrain.group);
      r.terrain.dispose();
    }
  };

  let rig = buildRig({ trajectory: opts.trajectory, timeline: opts.timeline, siteId: opts.siteId });

  /** Fills the two trail lines for instant t (points near the bodies pushed out like the rocket). */
  const updateTrail = (t: number, state: SceneState, siteKm: Vec3 | null, anchor: Vec3, lambda: number, rocketAt: Vec3) => {
    const { trail, trailMoon, lunarArrivalMs, style, flown, ahead } = rig;
    if (!trail || !trailMoon) return;
    const moonKm = state.moonKm;
    // A9: from 3 h before lunar arrival on, each point is carried with the Moon (moved and turned) from its own
    // instant to now, so the path round the Moon (approach, low orbits, descent to the site) is drawn as it is
    // relative to the Moon, which the camera follows; before that, the path through space as it was. A smooth
    // weight joins the two. Points are drawn like the rocket (rocketScenePoint), so they meet it at every scale.
    const ride = (i: number): Vec3 => {
      const w = smoothstep01((trail.tMs[i] - (lunarArrivalMs + FOLLOW_WINDOWS.in[0])) / -FOLLOW_WINDOWS.in[0]);
      const km = trail.km[i];
      if (w <= 0) return km;
      const m = trailMoon[i];
      const body = rotate(conjugate(m.quat), [km[0] - m.km[0], km[1] - m.km[1], km[2] - m.km[2]]);
      const now = rotate(state.moonQuat, body);
      const carried: Vec3 = [moonKm[0] + now[0], moonKm[1] + now[1], moonKm[2] + now[2]];
      return [km[0] + (carried[0] - km[0]) * w, km[1] + (carried[1] - km[1]) * w, km[2] + (carried[2] - km[2]) * w];
    };
    let split = trail.tMs.findIndex((x) => x > t);
    if (split < 0) split = trail.tMs.length;
    const fill = (line: THREE.Line, from: number, to: number, last: Vec3 | null, first: Vec3 | null) => {
      const attr = line.geometry.getAttribute("position") as THREE.BufferAttribute;
      let n = 0;
      const put = (p: Vec3) => attr.setXYZ(n++, p[0], p[1], p[2]);
      if (first) put(first);
      for (let i = from; i < to; i++) put(rocketScenePoint(ride(i), moonKm, siteKm, anchor, lambda));
      if (last) put(last);
      line.geometry.setDrawRange(0, n);
      attr.needsUpdate = true;
      if (style?.dashed && n > 1) line.computeLineDistances();
    };
    // both lines meet at the rocket, so the trail never shows a gap at "now"
    fill(flown, 0, Math.min(split, trail.km.length - 1), rocketAt, null);
    fill(ahead, split, trail.km.length, null, rocketAt);
  };

  const moonQ = new THREE.Quaternion();

  // camera director and user take-over (T4.3.a)
  const controller = new CameraController();
  const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const reduced = { get matches() { return opts.reducedMotion ? opts.reducedMotion() : (media?.matches ?? false); } };
  let lastPose: Pose | null = null;
  let earthW: Vec3 = [0, 0, 0];
  let moonW: Vec3 = [0, 0, 0];
  // body frames of the last drawn instant, to carry the camera across a change of plan (T4.4.b)
  let lastFrames: { earth: BodyFrame; moon: BodyFrame } | null = null;
  /** the site where lastPose was drawn: the site moves with the Moon between frames */
  let lastSite: Vec3 | null = null;
  let switching: { from: { earth: Pose; moon: Pose }; startMs: number } | null = null;
  let wasPlanning = opts.planning?.() ?? false;
  // surface view (TR.3.a): the gaze, and the hop between the aerial site framing and standing on the site
  const look = { az: Number.NaN, el: SURFACE_LOOK_EL, fov: SURFACE_FOV.initial as number };
  let surfaceOn = false;
  let surfaceHop: { rel: Pose; startMs: number } | null = null;
  const overlay = createSkyOverlay(container);
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", STRINGS.live.cameraHelp);
  const takeOver = () => {
    if (lastPose && controller.mode === "director") {
      switching = null;
      controller.cancel(lastPose, earthW, moonW);
      opts.onCameraModeChange?.("manual");
    }
  };
  // closest approach of the manual camera: 5 % of the body as drawn in space, 0.5 km over the site at real
  // scale (A3: the aerial framing is ~5 km away, and the space floor of ~520 km made the first zoom jump out)
  const minDist = () => (lambda >= 0.5 ? 0.5 / 1000 : (controller.orbit?.body === "moon" ? moonR : earthR) * 0.05);
  // A3: proportional wheel and pinch zoom that eases in, and a spin that coasts after the drag (cameraInput.ts)
  const motion = new CameraMotion();
  let lastStepMs = performance.now();
  let drag: { x: number; y: number } | null = null;
  const onDown = (e: PointerEvent) => {
    if (!surfaceOn) takeOver(); // standing on the site, dragging turns the gaze instead
    motion.grab();
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    if (surfaceOn) {
      // grab the sky: a drag across the whole height turns the gaze by the field of view
      const k = look.fov / Math.max(1, container.clientHeight);
      look.az = (look.az - (e.clientX - drag.x) * k + 360) % 360;
      look.el = Math.max(-30, Math.min(85, look.el + (e.clientY - drag.y) * k));
    } else {
      const dYaw = -(e.clientX - drag.x) * 0.005;
      const dPitch = (e.clientY - drag.y) * 0.005;
      controller.rotate(dYaw, dPitch);
      motion.track(dYaw, dPitch, e.timeStamp);
    }
    drag = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent) => {
    if (drag && !surfaceOn) motion.release(e.timeStamp);
    drag = null;
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (surfaceOn) {
      look.fov = Math.max(SURFACE_FOV.min, Math.min(SURFACE_FOV.max, look.fov * Math.exp(wheelZoom(e))));
      return;
    }
    takeOver();
    motion.addZoom(wheelZoom(e));
  };
  const onKey = (e: KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowLeft: () => controller.rotate(0.06, 0),
      ArrowRight: () => controller.rotate(-0.06, 0),
      ArrowUp: () => controller.rotate(0, 0.06),
      ArrowDown: () => controller.rotate(0, -0.06),
      "+": () => motion.addZoom(-Math.log(1.15)),
      "-": () => motion.addZoom(Math.log(1.15)),
    };
    const surfaceKeys: Record<string, () => void> = {
      ArrowLeft: () => (look.az = (look.az - 3 + 360) % 360),
      ArrowRight: () => (look.az = (look.az + 3) % 360),
      ArrowUp: () => (look.el = Math.min(85, look.el + 3)),
      ArrowDown: () => (look.el = Math.max(-30, look.el - 3)),
      "+": () => (look.fov = Math.max(SURFACE_FOV.min, look.fov / 1.15)),
      "-": () => (look.fov = Math.min(SURFACE_FOV.max, look.fov * 1.15)),
    };
    const action = (surfaceOn ? surfaceKeys : keys)[e.key];
    if (!action) return;
    e.preventDefault();
    if (!surfaceOn) takeOver();
    action();
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("keydown", onKey);

  const Y = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const up = new THREE.Vector3();
  let lambda = 0;
  let reportedScale: "space" | "local" | null = null; // A2: the first frame always reports its scale
  if (import.meta.env.DEV)
    (window as unknown as { __pp3d?: unknown }).__pp3d = {
      THREE,
      renderer,
      ...handle,
      handle,
      bodies,
      ix,
      rocket,
      pad,
      controller,
      terrain: () => rig.terrain,
      lastPose: () => lastPose,
      lastFrames: () => lastFrames,
      lambda: () => lambda,
      switching: () => switching !== null,
    };

  const resize = () => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, true);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  renderer.setAnimationLoop(() => {
    const { traj, tl, siteBody, siteRadiusUnits, terrain, landingMs, flown, ahead } = rig;
    const planning = opts.planning?.() ?? false;
    // while planning, the globe is shown as it will be at the start of the countdown (pad under the camera)
    const t = planning && tl ? tl.startMs : opts.getTimeMs();
    const state = sceneStateAt(ix, t);
    updateBodies(bodies, state, handle);
    earthW = [0, 0, 0];
    moonW = toScene(state.moonKm);
    const siteKm = siteBody ? sitePositionKm(siteBody, state.moonKm, state.moonQuat) : null;
    const input: DirectorInput = {
      t,
      moon: moonW,
      sunDir: state.sunDir,
      earthRadius: earthR,
      moonRadius: moonR,
      padUpAtLaunch: rig.padUpAtLaunch,
      moonNorth: rotate(state.moonQuat, [0, 0, 1]),
      site: moonW, // set just below, once λ is known
    };
    // local scale λ (T4.3.b): 0 = space scale (bodies ×6), 1 = real local scale at the site
    lambda = tl ? (reduced?.matches ? (t >= tl.landingMs ? 1 : 0) : localBlend(tl, t)) : 0;
    // the site as drawn (×6): the fixed point of the re-scaling (the camera path stays smooth)
    const anchor = siteKm ? pointToScene(siteKm, state.moonKm) : moonW;
    input.site = anchor;
    // the rocket as drawn: on the pad, then the trajectory, then on the site (which moves with the Moon); placed
    // before the camera so the director can follow it down (A9)
    const rocketKm = traj ? (t >= landingMs && siteKm ? siteKm : launchPositionKm(traj, state.earthQuat, t)) : null;
    const rocketAt = rocketKm ? rocketScenePoint(rocketKm, state.moonKm, siteKm, anchor, lambda) : null;
    if (rocketAt && !planning) input.rocket = rocketAt;
    // …and 1 minute later, carried back with the Moon to now: its heading relative to the Moon, which the camera
    // follows round the Moon (A9); after landing it stays on the site
    let rocketAhead: Vec3 | null = null;
    if (traj && rocketAt) {
      const ta = t + 60_000;
      const s2 = sceneStateAt(ix, ta);
      const site2 = siteBody ? sitePositionKm(siteBody, s2.moonKm, s2.moonQuat) : null;
      const km2 = ta >= landingMs && site2 ? site2 : launchPositionKm(traj, s2.earthQuat, ta);
      const back: Vec3 = [km2[0] + state.moonKm[0] - s2.moonKm[0], km2[1] + state.moonKm[1] - s2.moonKm[1], km2[2] + state.moonKm[2] - s2.moonKm[2]];
      rocketAhead = t >= landingMs ? rocketAt : rocketScenePoint(back, state.moonKm, siteKm, anchor, lambda);
      if (!planning) input.rocketAhead = rocketAhead;
    }
    const scaleNow = lambda >= 0.5 ? "local" : "space";
    if (scaleNow !== reportedScale) {
      reportedScale = scaleNow;
      opts.onScaleChange?.(scaleNow);
    }
    // …and the Earth moves so that, at real local scale, site → Earth is the true vector
    earthW = siteKm && lambda > 0 ? earthOffset(siteKm, state.moonKm, lambda) : [0, 0, 0];
    handle.world.set(bodies.earth, earthW);
    let moonDrawnR = moonR;
    if (lambda > 0 && siteBody) {
      // re-scale anchored at the site: the Moon centre slides towards the site and the sphere shrinks to its
      // real size, so the ground under the camera stays put and only its curvature changes
      const n = unit([anchor[0] - moonW[0], anchor[1] - moonW[1], anchor[2] - moonW[2]]);
      const r = Math.hypot(anchor[0] - moonW[0], anchor[1] - moonW[1], anchor[2] - moonW[2]) * (1 - lambda) + siteRadiusUnits * lambda;
      moonW = [anchor[0] - n[0] * r, anchor[1] - n[1] * r, anchor[2] - n[2] * r];
      handle.world.set(bodies.moon, moonW);
      moonDrawnR = moonR * (1 - lambda) + ((MOON_RADIUS_KM - MOON_SPHERE_DROP_KM) / 1000) * lambda;
      bodies.moon.scale.setScalar(moonDrawnR / moonR);
    } else bodies.moon.scale.setScalar(1);
    // the Earth also goes back to its real size at real local scale (seen from the site it is a ~1.9° disc,
    // like in the 2D panorama); it is far away, so no anchoring is needed
    const earthK = 1 - (1 - 1 / SPACE_SCALE.bodyExaggeration) * lambda;
    bodies.earth.scale.set(earthK, earthK * (EARTH_RADII_KM.polar / EARTH_RADII_KM.equatorial), earthK);

    if (wasPlanning !== planning) {
      // "Launch" (or back to planning): leave the current view, the user's own included, and hop to the new one
      if (lastPose && lastFrames && !reduced?.matches) switching = { from: { earth: toFrame(lastPose, lastFrames.earth), moon: toFrame(lastPose, lastFrames.moon) }, startMs: performance.now() };
      if (controller.mode === "manual") {
        controller.resume();
        opts.onCameraModeChange?.("director");
      }
    }
    wasPlanning = planning;
    const stepNow = performance.now();
    const step = motion.step(Math.min(stepNow - lastStepMs, 100), reduced.matches);
    lastStepMs = stepNow;
    if (controller.mode === "manual") {
      if (step.zoom) controller.zoom(Math.exp(step.zoom), minDist());
      if (step.yaw || step.pitch) controller.rotate(step.yaw, step.pitch);
    } else if (!motion.idle) motion.stop(); // the guided camera is back: drop what was left
    input.moonDrawn = drawnMoonCentre(input.moon, anchor, siteBody ? lambda : 0, siteRadiusUnits);
    let pose =
      (controller.mode === "manual" ? controller.manualPose(earthW, moonW) : null) ??
      (planning ? planningPose(input) : tl ? (reduced?.matches ? reducedMotionPose(tl, input) : directorPose(tl, input)) : transitPose(input));
    const frames: { earth: BodyFrame; moon: BodyFrame } = {
      earth: { centre: earthW, quat: null, radius: earthR * earthK },
      moon: { centre: moonW, quat: state.moonQuat, radius: moonDrawnR },
    };
    if (switching) {
      // change of plan (T4.4.b): hop from the old view, kept relative to the ground of the body it framed, to
      // the new plan's view, in the frame of the body the new view frames (the Earth at launch, else the Moon)
      const w = switchEase(performance.now() - switching.startMs);
      if (w >= 1) switching = null;
      else {
        const kind = planning || (tl && phaseAt(tl, t) === "launch") ? "earth" : "moon";
        const f = frames[kind];
        pose = fromFrame(hopPose(switching.from[kind], toFrame(pose, f), w, f.radius), f);
      }
    }
    // surface view (TR.3.a): stand on the site at h_obs once the scene is at real scale, if Level B is on
    const surface = !!(siteBody && lambda >= 1 && opts.levelB?.() !== false && opts.surface?.());
    let enu: Enu | null = null;
    let sky: ReturnType<typeof skyAzEl> | null = null;
    if (siteBody && lambda >= 1) {
      const b = enuBasis(siteBody);
      const q = state.moonQuat;
      enu = { east: rotate(q, b.east), north: rotate(q, b.north), up: rotate(q, b.up) };
      sky = skyAzEl(state, siteBody);
    }
    if (surface !== surfaceOn) {
      // hop between the aerial framing and the observer's eye: log distance to the site, smooth turn (no cut)
      // relative to the site of lastPose's own frame (A9: at touchdown in slow motion the site moves km per frame)
      const from = lastSite ?? input.site;
      if (lastPose && !reduced?.matches) surfaceHop = { rel: { position: sub3(lastPose.position, from), target: sub3(lastPose.target, from), up: lastPose.up }, startMs: performance.now() };
      if (surface && Number.isNaN(look.az) && sky) look.az = sky.earth[0]; // first look: towards the Earth
      if (surface && controller.mode === "manual") {
        controller.resume();
        opts.onCameraModeChange?.("director");
      }
      surfaceOn = surface;
    }
    if (surface && enu) {
      const eye = add3(input.site, scale3(enu.up, H_OBS_M / 1e6));
      const fwd = dirOf(enu, look.az, look.el);
      pose = { position: eye, target: add3(eye, scale3(fwd, 1e-3)), up: dirOf(enu, look.az, look.el + 90) };
    }
    if (surfaceHop) {
      const w = switchEase(performance.now() - surfaceHop.startMs);
      if (w >= 1) surfaceHop = null;
      else {
        const r = surfaceHop.rel;
        pose = approachPose({ position: add3(r.position, input.site), target: add3(r.target, input.site), up: r.up }, pose, input.site, w);
      }
    }
    const mapOpacity = tl && opts.polarMap?.() ? polarMapOpacity(tl, t, lambda) : 0;
    const mapMat = polarMap.material as THREE.MeshBasicMaterial;
    mapMat.opacity = mapOpacity;
    polarMap.visible = mapOpacity > 0.01 && mapMat.map !== null;
    if (polarMap.visible !== polarMapShown) {
      polarMapShown = polarMap.visible;
      opts.onPolarMapVisible?.(polarMapShown);
    }
    const fov = surfaceOn ? look.fov : 45;
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    lastPose = pose;
    lastFrames = frames;
    lastSite = input.site;
    handle.cameraWorld = pose.position;

    if (terrain && siteBody) {
      terrain.update(Math.hypot(pose.position[0] - anchor[0], pose.position[1] - anchor[1], pose.position[2] - anchor[2]), lambda);
      handle.world.set(terrain.group, anchor);
      terrain.group.quaternion.copy(moonQ.set(...state.moonQuat)); // Moon-fixed geometry, relative to the site
      terrain.showMarker(!surfaceOn); // C3c: the landing point, marked from above
    }

    // standing on the site, the observer is the lander: its ~100 m model would stand 3 m away and fill the view
    rocket.visible = !!traj && !surfaceOn;
    if (traj) {
      // rocket: on the pad during the countdown, then the trajectory; after landing it stays on the site,
      // which moves with the Moon
      const stage = launchStage(traj, t);
      const p = rocketAt as Vec3;
      handle.world.set(rocket, p);
      if (t >= landingMs) dir.set(input.site[0] - moonW[0], input.site[1] - moonW[1], input.site[2] - moonW[2]); // standing on the site
      else if (stage === "flight") {
        // nose along the motion relative to the Moon (the heading the camera follows, A9)
        const next = rocketAhead ?? p;
        dir.set(next[0] - p[0], next[1] - p[1], next[2] - p[2]).normalize();
        // A9: through the powered descent the lander turns upright, so it touches down standing (no flip)
        const upright = smoothstep01((t - (landingMs - DESCENT_UPRIGHT_MS)) / DESCENT_UPRIGHT_MS);
        if (upright > 0) dir.lerp(up.set(p[0] - moonW[0], p[1] - moonW[1], p[2] - moonW[2]).normalize(), upright);
      } else dir.set(p[0], p[1], p[2]); // standing up and climbing: along the local vertical
      if (dir.lengthSq() > 0) rocket.quaternion.setFromUnitVectors(Y, dir.normalize());
      const dist = Math.hypot(p[0] - pose.position[0], p[1] - pose.position[1], p[2] - pose.position[2]);
      // enlarged in space (constant apparent size), real size (~100 m) at real local scale
      const drawn = apparentLength(dist, camera.fov, ROCKET_SCREEN_FRACTION) * (1 - lambda) + ROCKET_REAL_LENGTH_UNITS * lambda;
      // A9: while it flies, never smaller than 6 % of the view, so the camera's subject stays in sight from the
      // low orbits (km away) down to the descent; on the ground, its real size
      rocket.scale.setScalar(t < landingMs ? Math.max(drawn, apparentLength(dist, camera.fov, 0.06)) : drawn);
      setPlume(plume, plumeIntensity(traj, t));
      // detailed launch (T6.3.a): stage separation and fairing; off = the MVP rocket, all in one piece
      setStaging(rocket, plume, opts.detailedLaunch?.() ? stagingAt(traj, t) : null);
      // the trail belongs to the flight: hidden once landed (its end stays in space while the Moon moves on)
      // A9: the path ahead stays in view down to the site (it is what the camera follows); the path already flown
      // fades as the real scale comes in (seen from beside the lander it would be lines across the sky); dashes
      // shrink with the scale
      ahead.visible = t < landingMs;
      flown.visible = t < landingMs && lambda < 1;
      for (const line of [flown, ahead]) {
        const m = line.material as THREE.LineDashedMaterial;
        m.opacity = line === flown ? 0.9 * (1 - lambda) : 0.9;
        if (m.isLineDashedMaterial) {
          m.dashSize = 2.5 * (1 - lambda) + 0.0004 * lambda; // 2 500 km in space, 400 m at real scale
          m.gapSize = 1.8 * (1 - lambda) + 0.0003 * lambda;
        }
      }
      if (ahead.visible) updateTrail(t, state, siteKm, anchor, lambda, p);
      // pad marker while the launch phase lasts
      pad.visible = t < rig.injectionMs;
      if (pad.visible) handle.world.set(pad, pointToScene(padPositionKm(state.earthQuat), state.moonKm));
    }
    applyCameraRelative(handle);
    // Level B: the light sits SHADOW_DEPTH towards the Sun from the site, so its shadow box covers the ground
    // around the site and the ridges between it and the Sun (camera-relative positions, set just above)
    const shadows = !!(webgl && terrain && opts.levelB?.() !== false && lambda >= 0.95 && terrain.group.visible);
    if (bodies.sunLight.castShadow !== shadows) {
      bodies.sunLight.castShadow = shadows;
      shadowAt = { t: Number.NaN, version: -1 };
    }
    if (shadows && terrain && webgl) {
      const g = terrain.group.position;
      bodies.sunLight.target.position.copy(g);
      bodies.sunLight.target.updateMatrixWorld();
      // sunlight as seen from the site (corrected for the Earth-Moon parallax, ~0.15 deg: it matters at a grazing Sun)
      const sunAtSite = sky && enu ? dirOf(enu, sky.sun[0], sky.sun[1]) : state.sunDir;
      bodies.sunLight.position.set(g.x + sunAtSite[0] * SHADOW_DEPTH, g.y + sunAtSite[1] * SHADOW_DEPTH, g.z + sunAtSite[2] * SHADOW_DEPTH);
      if (!(Math.abs(t - shadowAt.t) < SHADOW_REDRAW_MS) || terrain.version !== shadowAt.version) {
        webgl.shadowMap.needsUpdate = true;
        shadowAt = { t, version: terrain.version };
      }
    }
    camera.up.set(...pose.up);
    camera.lookAt(pose.target[0] - pose.position[0], pose.target[1] - pose.position[1], pose.target[2] - pose.position[2]);
    renderer.render(scene, camera);
    if (surfaceOn && enu && sky && !surfaceHop) overlay.update(camera, enu, sky.sun, sky.earth);
    else overlay.hide();
  });

  return {
    resumeCamera() {
      controller.resume();
      opts.onCameraModeChange?.("director");
    },
    setPlan(p) {
      // the camera leaves from where it is, kept relative to each body's ground, and hops to the new view
      if (lastPose && lastFrames && !reduced?.matches) {
        switching = { from: { earth: toFrame(lastPose, lastFrames.earth), moon: toFrame(lastPose, lastFrames.moon) }, startMs: performance.now() };
      }
      if (controller.mode === "manual") {
        controller.resume();
        opts.onCameraModeChange?.("director");
      }
      disposeRig(rig);
      rig = buildRig(p);
    },
    unmount() {
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("keydown", onKey);
      overlay.dispose();
      rendererManager.release();
      rig.terrain?.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mats = (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) as THREE.Material[];
        for (const mat of mats) {
          (mat as THREE.MeshStandardMaterial).map?.dispose();
          mat.dispose();
        }
      });
      scene.clear();
    },
  };
}
