/**
 * T4.3.a: camera director. Over the whole mission, sampled frame by frame at playback speed, the camera never
 * jumps (view direction, up vector and position change per frame stay under thresholds); taking the camera
 * hands control to the user without a jump, and "guided camera" gives it back.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Plan, SceneEphemeris, Trajectory } from "../src/lib/contract";
import { parseInstant } from "../src/lib/contract";
import { timelineOf, type MissionTimeline } from "../src/lib/mission";
import { CameraMotion, MAX_STEP, wheelZoom } from "../src/scene3d/cameraInput";
import { CHASE_KM, CHASE_WINDOWS, localBlend } from "../src/scene3d/cameraDirector";
import { playbackRate } from "../src/lib/mission";
import { CameraController, directorPose, hopPose, planningPose, reducedMotionPose, SWITCH_MS, sitePose, switchEase, type DirectorInput, type Pose } from "../src/scene3d/cameraDirector";
import { indexEphemeris, rotate, sceneStateAt } from "../src/scene3d/ephemeris";
import { launchPositionKm, padUp } from "../src/scene3d/launch";
import { bodyRadius, EARTH_RADII_KM, MOON_RADIUS_KM, pointToScene, rocketScenePoint, toScene, type Vec3 } from "../src/scene3d/scale";
import { siteBodyFixedKm, sitePositionKm } from "../src/scene3d/trajectory";

const DATA = join(__dirname, "..", "public", "data");
const eph = JSON.parse(readFileSync(join(DATA, "scene", "ephemeris.json"), "utf-8")) as SceneEphemeris;
const ix = indexEphemeris(eph);
const plans = JSON.parse(readFileSync(join(DATA, "plans.json"), "utf-8")) as { plans: Plan[] } | Plan[];
const planList = Array.isArray(plans) ? plans : plans.plans;

function setup(planId: string) {
  const plan = planList.find((p) => p.id === planId)!;
  const traj = JSON.parse(readFileSync(join(DATA, "trajectory", `${plan.trajectory_id}.json`), "utf-8")) as Trajectory;
  const tl = timelineOf(plan, traj);
  const padUpAtLaunch = padUp(sceneStateAt(ix, parseInstant(traj.phases.launch_utc)).earthQuat);
  const siteBody = siteBodyFixedKm(traj, ix);
  const input = (t: number): DirectorInput => {
    const s = sceneStateAt(ix, t);
    // the rocket as the renderer draws it (A9: the director follows it down to the site)
    const siteKm = sitePositionKm(siteBody, s.moonKm, s.moonQuat);
    const anchor = pointToScene(siteKm, s.moonKm);
    const rocketKm = t >= tl.landingMs ? siteKm : launchPositionKm(traj, s.earthQuat, t);
    return {
      rocket: rocketScenePoint(rocketKm, s.moonKm, siteKm, anchor, localBlend(tl, t)),
      t,
      moon: toScene(s.moonKm),
      sunDir: s.sunDir,
      earthRadius: bodyRadius(EARTH_RADII_KM.equatorial),
      moonRadius: bodyRadius(MOON_RADIUS_KM),
      padUpAtLaunch,
      moonNorth: rotate(s.moonQuat, [0, 0, 1]),
      site: pointToScene(sitePositionKm(siteBody, s.moonKm, s.moonQuat), s.moonKm),
    };
  };
  return { plan, traj, tl, input };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(...a);
const angle = (a: Vec3, b: Vec3) => {
  const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (len(a) * len(b));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
};
const view = (p: Pose) => sub(p.target, p.position);

/** Frame by frame at 60 fps and `hoursPerSecond`, at the rate the playback really runs (slow around launch and
 *  landing, A9), from the countdown to the end of the stay. */
function jumps(tl: MissionTimeline, input: (t: number) => DirectorInput, hoursPerSecond: number) {
  let maxDir = 0;
  let maxUp = 0;
  let maxRel = 0;
  let atDir = 0;
  let atUp = 0;
  let prev = directorPose(tl, input(tl.startMs));
  for (let t = tl.startMs + (1000 / 60) * playbackRate(tl, tl.startMs, hoursPerSecond); t <= tl.endMs; t += (1000 / 60) * playbackRate(tl, t, hoursPerSecond)) {
    const p = directorPose(tl, input(t));
    const d = angle(view(prev), view(p));
    const u = angle(prev.up, p.up);
    if (d > maxDir) [maxDir, atDir] = [d, t];
    if (u > maxUp) [maxUp, atUp] = [u, t];
    // camera motion relative to what it looks at (a translation shared by camera and target — e.g. riding with
    // the Moon at ~1 km/s after landing — changes nothing on screen)
    maxRel = Math.max(maxRel, len(sub(view(p), view(prev))) / len(view(prev)));
    prev = p;
  }
  // where the worst frames are, in hours from launch (for diagnosis)
  const h = (t: number) => ((t - tl.launchMs) / 3_600_000).toFixed(1);
  return { maxDir, maxUp, maxRel, where: `view worst at T+${h(atDir)} h, up worst at T+${h(atUp)} h (injection T+${h(tl.injectionMs)}, lunar arrival T+${h(tl.lunarArrivalMs)}, landing T+${h(tl.landingMs)})` };
}

describe("camera director: continuous path, no jumps between frames", () => {
  for (const planId of ["haworth_20270309_7d", "connecting_ridge_20270102_7d", "malapert_massif_20271015_14d"]) {
    it(`${planId}: at 6 h/s (6 min of mission per frame at 60 fps, slower around launch and landing) and at 1 h/s`, () => {
      const { tl, input } = setup(planId);
      const fast = jumps(tl, input, 6);
      const slow = jumps(tl, input, 1);
      console.log(
        `camera ${planId}: per frame at 6 h/s → view ${fast.maxDir.toFixed(2)}°, up ${fast.maxUp.toFixed(2)}°, move ${(fast.maxRel * 100).toFixed(1)} % of the distance; at 1 h/s → ${slow.maxDir.toFixed(2)}°, ${slow.maxUp.toFixed(2)}°, ${(slow.maxRel * 100).toFixed(1)} % · ${fast.where}`,
      );
      expect(fast.maxDir).toBeLessThan(6);
      expect(fast.maxUp).toBeLessThan(6);
      expect(fast.maxRel).toBeLessThan(0.2);
      expect(slow.maxDir).toBeLessThan(1.5);
    });
  }

  it("no jumps across the year either: 25 plans, every site, at 6 h/s", () => {
    const ids = planList.filter((p) => p.window_days === 7).filter((_, i) => i % 73 === 0).map((p) => p.id);
    let worst = { dir: 0, up: 0, rel: 0 };
    for (const id of ids) {
      const { tl, input } = setup(id);
      const j = jumps(tl, input, 6);
      if (j.maxUp > 6 || j.maxDir > 6) console.log(`camera ${id}: view ${j.maxDir.toFixed(2)}°, up ${j.maxUp.toFixed(2)}° · ${j.where}`);
      worst = { dir: Math.max(worst.dir, j.maxDir), up: Math.max(worst.up, j.maxUp), rel: Math.max(worst.rel, j.maxRel) };
    }
    console.log(`camera, ${ids.length} plans at 6 h/s: worst view ${worst.dir.toFixed(2)}°, up ${worst.up.toFixed(2)}°, move ${(worst.rel * 100).toFixed(1)} %`);
    expect(ids.length).toBeGreaterThanOrEqual(25);
    expect(new Set(ids.map((id) => id.replace(/_\d{8}_\d+d$/, ""))).size).toBe(5);
    expect(worst.dir).toBeLessThan(6);
    expect(worst.up).toBeLessThan(6);
    expect(worst.rel).toBeLessThan(0.2);
  });

  it("ends at the site framing once the lander has touched down, after travelling Earth → Moon", () => {
    const { tl, input } = setup("haworth_20270309_7d");
    const settled = tl.landingMs + CHASE_WINDOWS.out[1];
    const atEnd = directorPose(tl, input(settled));
    const framing = sitePose(input(settled));
    expect(len(sub(atEnd.position, framing.position))).toBeLessThan(1e-12);
    const start = directorPose(tl, input(tl.startMs));
    expect(len(start.target)).toBeLessThan(bodyRadius(EARTH_RADII_KM.equatorial)); // looks at the Earth at launch
    // at the end: a few km from the site at real local scale (1.5 km up, 5 km back), looking 10 km past it
    const site = input(settled).site;
    expect(len(sub(atEnd.position, site)) * 1000).toBeCloseTo(Math.hypot(1.5, 5), 6);
    expect(len(sub(atEnd.target, site)) * 1000).toBeCloseTo(10, 6);
  });

  it("A9: follows the lander down the powered descent, keeping it in view, and touches down with it", () => {
    for (const planId of ["haworth_20270309_7d", "connecting_ridge_20270102_7d", "malapert_massif_20271015_14d"]) {
      const { tl, input } = setup(planId);
      let far = 0;
      let off = 0;
      // from the end of the catch-up to touchdown, every 10 s of mission
      for (let t = tl.landingMs + CHASE_WINDOWS.in[1]; t <= tl.landingMs; t += 10_000) {
        const i = input(t);
        const p = directorPose(tl, i);
        const toRocket = sub(i.rocket as Vec3, p.position);
        far = Math.max(far, len(toRocket) * 1000); // km
        off = Math.max(off, angle(view(p), toRocket)); // the lander's angle from the centre of the view
      }
      expect(far, planId).toBeLessThan(Math.hypot(CHASE_KM.back, CHASE_KM.up) + 0.01);
      expect(off, planId).toBeLessThan(25); // well inside the 45° field of view
      // at touchdown the camera is behind the lander, on the site, and already looks the site framing's way
      const i = input(tl.landingMs);
      const atTouchdown = directorPose(tl, i);
      expect(len(sub(i.rocket as Vec3, i.site))).toBeLessThan(1e-9);
      expect(angle(view(atTouchdown), view(sitePose(i)))).toBeLessThan(15);
    }
  });
});

describe("reduced motion", () => {
  it("holds one framing per phase: static within a phase apart from the bodies' own motion", () => {
    const { tl, input } = setup("haworth_20270309_7d");
    const a = reducedMotionPose(tl, input(tl.startMs));
    const b = reducedMotionPose(tl, input(tl.injectionMs - 60_000));
    expect(len(sub(a.position, b.position))).toBeLessThan(1e-9); // launch framing does not move at all
    const c = reducedMotionPose(tl, input(tl.injectionMs + 60_000));
    expect(len(sub(a.position, c.position))).toBeGreaterThan(10); // cut at the phase change instead of a sweep
  });
});

describe("user take-over (cancel) and guided camera", () => {
  it("cancelling keeps the current pose, then the user orbits the nearest body; resume returns to the director", () => {
    const { tl, input } = setup("haworth_20270309_7d");
    const t = tl.lunarArrivalMs + 3 * 3_600_000; // approaching the Moon
    const i = input(t);
    const current = directorPose(tl, i);
    const c = new CameraController();
    c.cancel(current, [0, 0, 0], i.moon);
    expect(c.mode).toBe("manual");
    expect(c.orbit?.body).toBe("moon");
    const same = c.manualPose([0, 0, 0], i.moon)!;
    expect(len(sub(same.position, current.position))).toBeLessThan(1e-6); // no jump when taking over
    expect(len(sub(same.target, current.target))).toBeLessThan(1e-9);
    c.rotate(0.3, 0.1);
    c.zoom(2, 0.1);
    const moved = c.manualPose([0, 0, 0], i.moon)!;
    expect(len(sub(moved.position, current.position))).toBeGreaterThan(1);
    expect(len(sub(moved.position, moved.target))).toBeCloseTo(2 * len(view(current)), 6);
    // the manual camera follows the Moon as time goes on
    const later = input(t + 3_600_000);
    const follow = c.manualPose([0, 0, 0], later.moon)!;
    expect(len(sub(sub(follow.target, later.moon), sub(moved.target, i.moon)))).toBeLessThan(1e-9);
    c.resume();
    expect(c.mode).toBe("director");
    expect(c.manualPose([0, 0, 0], i.moon)).toBeNull();
  });
});

describe("planning globe (TR.2.a, design A2)", () => {
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unitV = (a: Vec3): Vec3 => a.map((c) => c / len(a)) as Vec3;

  it("shows the whole Earth, leaning to the lit side with the pad in view, right of centre and north up", () => {
    for (const id of ["haworth_20270309_7d", "malapert_massif_20271015_14d"]) {
      const { tl, input } = setup(id);
      const i = input(tl.startMs);
      const p = planningPose(i);
      const fwd = unitV(view(p));
      const toEarth = sub([0, 0, 0], p.position);
      const R = i.earthRadius;
      // the globe fits: vertically inside the 45° field of view (22.5° half-angle; the shift is sideways only),
      // horizontally inside the 16:9 field (36.4° half-angle), with margin
      const radiusDeg = (Math.asin(R / len(toEarth)) * 180) / Math.PI;
      expect(Math.abs(dot(unitV(toEarth), unitV(p.up)))).toBeLessThan(1e-9);
      expect(radiusDeg).toBeLessThan(21);
      expect(angle(fwd, toEarth) + radiusDeg).toBeLessThan(34);
      // the camera leans from the pad towards the Sun (night launches): the pad stays well inside the visible
      // face (≤ 55° from its centre) and the view never turns away from the lit side
      const camDir = unitV(sub(p.position, p.target));
      expect(dot(camDir, i.padUpAtLaunch)).toBeGreaterThan(Math.cos((56 * Math.PI) / 180));
      expect(dot(camDir, i.sunDir)).toBeGreaterThanOrEqual(dot(i.padUpAtLaunch, i.sunDir) - 1e-9);
      // the Earth is drawn right of the screen centre (the sidebar covers the left)
      const right = cross(fwd, p.up);
      expect(dot(unitV(toEarth), right)).toBeGreaterThan(0.1);
      expect(p.up[2]).toBeGreaterThan(0); // celestial north up
    }
  });

  it("'Launch' hops from the globe to the launch framing without a jump (60 fps over SWITCH_MS)", () => {
    const { tl, input } = setup("haworth_20270309_7d");
    const i = input(tl.startMs);
    const from = planningPose(i);
    const to = directorPose(tl, i);
    let prev = from;
    let worst = 0;
    for (let ms = 1000 / 60; ms <= SWITCH_MS + 1; ms += 1000 / 60) {
      const p = hopPose(from, to, switchEase(ms), i.earthRadius);
      worst = Math.max(worst, angle(view(prev), view(p)));
      prev = p;
    }
    expect(len(sub(prev.position, to.position))).toBeLessThan(1e-9);
    expect(worst).toBeLessThan(6);
  });
});

/* ------------------------------------------------------------------ A3: comfortable manual camera */

describe("camera input (A3): proportional zoom, pinch, easing and inertia", () => {
  const frames = (m: CameraMotion, n: number, reduced = false) => Array.from({ length: n }, () => m.step(1000 / 60, reduced));

  it("the wheel zoom follows the scroll: one mouse notch ≈ the old ×1.1, a touchpad's small deltas add up to the same", () => {
    const notch = Math.exp(wheelZoom({ deltaY: 100, deltaMode: 0, ctrlKey: false }));
    expect(notch).toBeGreaterThan(1.1);
    expect(notch).toBeLessThan(1.15);
    expect(wheelZoom({ deltaY: -100, deltaMode: 0, ctrlKey: false })).toBeCloseTo(-Math.log(notch), 12);
    // 50 touchpad events of 2 px: each one tiny, together one notch
    const small = wheelZoom({ deltaY: 2, deltaMode: 0, ctrlKey: false });
    expect(Math.exp(small)).toBeLessThan(1.003);
    expect(50 * small).toBeCloseTo(Math.log(notch), 12);
    // lines (Firefox) count as 16 px; a huge delta is capped per event
    expect(wheelZoom({ deltaY: 3, deltaMode: 1, ctrlKey: false })).toBeCloseTo(48 * 0.0012, 12);
    expect(wheelZoom({ deltaY: 5000, deltaMode: 0, ctrlKey: false })).toBe(MAX_STEP);
  });

  it("a pinch (ctrlKey + wheel) zooms with its small deltas", () => {
    const pinch = wheelZoom({ deltaY: -10, deltaMode: 0, ctrlKey: true });
    expect(Math.exp(pinch)).toBeCloseTo(1 / Math.exp(0.1), 12); // ×1.1 closer for 10 px
    expect(Math.abs(pinch)).toBeGreaterThan(Math.abs(wheelZoom({ deltaY: -10, deltaMode: 0, ctrlKey: false })) * 5);
  });

  it("the zoom eases in over a few frames, with no jump and nothing lost", () => {
    const m = new CameraMotion();
    m.addZoom(0.3);
    const steps = frames(m, 60).map((s) => s.zoom);
    expect(Math.max(...steps)).toBeLessThan(0.06); // at most a fifth of it in one frame at 60 fps
    expect(steps.reduce((a, b) => a + b, 0)).toBeCloseTo(0.3, 9);
    expect(m.idle).toBe(true);
    for (let i = 1; i < 10; i++) expect(steps[i]).toBeLessThanOrEqual(steps[i - 1] + 1e-12); // a smooth decay
  });

  it("a drag released in motion coasts and stops; one that stopped first does not move on", () => {
    const m = new CameraMotion();
    m.grab();
    for (let t = 0; t <= 160; t += 16) m.track(0.02, 0, t); // 0.02 rad per 16 ms
    m.release(170);
    const spin = frames(m, 180).map((s) => s.yaw);
    expect(spin[0]).toBeGreaterThan(0);
    expect(spin[0]).toBeLessThan(0.03); // no more than the drag's own speed
    expect(spin.reduce((a, b) => a + b, 0)).toBeLessThan(0.5); // it slows down and stops
    expect(m.idle).toBe(true);

    const held = new CameraMotion();
    held.grab();
    for (let t = 0; t <= 160; t += 16) held.track(0.02, 0, t);
    held.release(400); // the pointer stood still before letting go
    expect(frames(held, 10).every((s) => s.yaw === 0)).toBe(true);
  });

  it("reduced motion: the zoom applies at once and nothing coasts", () => {
    const m = new CameraMotion();
    for (let t = 0; t <= 64; t += 16) m.track(0.02, 0, t);
    m.release(70);
    m.addZoom(-0.2);
    const [first, ...rest] = frames(m, 5, true);
    expect(first.zoom).toBeCloseTo(-0.2, 12);
    expect(first.yaw).toBe(0);
    expect(rest.every((s) => s.zoom === 0 && s.yaw === 0)).toBe(true);
  });

  it("the closest-approach floor never pushes the camera out in one jump", () => {
    const { tl, input } = setup("haworth_20270309_7d");
    const i = input(tl.lunarArrivalMs + 3 * 3_600_000);
    const c = new CameraController();
    c.cancel(directorPose(tl, i), [0, 0, 0], i.moon);
    const d0 = c.orbit!.dist;
    const floor = d0 * 10; // a camera already closer than the floor (the site at real scale)
    c.zoom(1.01, floor); // a tiny zoom out stays tiny
    expect(c.orbit!.dist).toBeCloseTo(d0 * 1.01, 9);
    c.zoom(0.5, floor); // a zoom in stops where it is
    expect(c.orbit!.dist).toBeCloseTo(d0 * 1.01, 9);
    c.zoom(0.5, d0 / 4); // otherwise it zooms in as asked…
    expect(c.orbit!.dist).toBeCloseTo(d0 * 0.505, 9);
    c.zoom(0.1, d0 / 4); // …down to the floor
    expect(c.orbit!.dist).toBeCloseTo(d0 / 4, 9);
  });

  it("the guided camera drops what was left (stop)", () => {
    const m = new CameraMotion();
    m.addZoom(0.3);
    m.stop();
    expect(m.idle).toBe(true);
    expect(frames(m, 3).every((s) => s.zoom === 0)).toBe(true);
  });
});
