/**
 * ILLUSTRATIVE trajectory built in the browser (B13, decision A14): a port of pipeline/trajectory.py `build()` for
 * any site, so a custom coordinate gets the same journey as the five candidate sites (launch, parking orbit,
 * translunar transfer, arrival with capture, low lunar orbit and powered descent, landing exactly on the site).
 *
 * The pipeline reads SPICE for three things only, and all three are in scene/ephemeris.json (the same geometric
 * J2000 states, every hour), interpolated as the scene does (scene3d/ephemeris.ts sceneStateAt):
 *   moon_pos(et)  → moonKm   (Catmull-Rom)      moon_rot(et) → moonQuat (slerp)      earth_rot(et) → earthQuat (slerp)
 * Same constants and the same piecewise curve, so for the five sites the result matches the published
 * trajectory/{id}.json within 1 km (tests/trajectoryBuilder.test.ts). Not a real mission trajectory.
 */
import type { Trajectory } from "./contract";
import { formatInstant } from "./contract";
import { conjugate, rotate, sceneStateAt, type EphemerisIndex } from "../scene3d/ephemeris";

type V = [number, number, number];

export const MODE = "ILLUSTRATIVE";
const R_EARTH_KM = 6378.137;
// A16: Launch Complex 39A at Cape Canaveral, as pipeline/config.py
const PAD_LAT_DEG = 28.60833;
const PAD_LON_DEG = -80.60444;
export const ASCENT_MIN = 10;
export const PARKING_ALT_KM = 200;
export const INJECTION_H = 2;
export const APPROACH_H = 12;
const MU_EARTH = 398600.4418; // km³/s²
// arrival (A5): design parameters; the lunar GM is DE440's (Park et al. 2021), only to shape the curve
const MU_MOON = 4902.800066;
const R_MOON_KM = 1737.4;
const LLO_ALT_KM = 100;
const PDI_ALT_KM = 15;
const PD_MIN = 12;
const PD_RANGE_KM = 480;
const LLO_REVS = 2;
const V_INF_KM_S = 0.8;
const H_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- vectors

const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V): V => mul(a, 1 / norm(a));
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** observer_position_km (pipeline/ephemeris.py): MOON_ME, radius 1737.4 km + elevation + h_obs. */
export function observerPositionKm(latDeg: number, lonDeg: number, elevationM: number, hObsM = 0): V {
  const r = R_MOON_KM + (elevationM + hObsM) / 1000;
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return [r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat)];
}

function slerpDir(a0: V, b0: V, s: number): V {
  const a = unit(a0);
  const b = unit(b0);
  const th = Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
  if (th < 1e-12) return a;
  return mul(add(mul(a, Math.sin((1 - s) * th)), mul(b, Math.sin(s * th))), 1 / Math.sin(th));
}

function hermite(p0: V, t0: V, p1: V, t1: V, s: number): V {
  const h00 = 2 * s ** 3 - 3 * s ** 2 + 1;
  const h10 = s ** 3 - 2 * s ** 2 + s;
  const h01 = -2 * s ** 3 + 3 * s ** 2;
  const h11 = s ** 3 - s ** 2;
  return add(add(mul(p0, h00), mul(t0, h10)), add(mul(p1, h01), mul(t1, h11)));
}

const smoothstep = (s: number) => s * s * (3 - 2 * s);

/** F with e·sinh F − F = M (Newton). */
function solveHyperbolic(m: number, e: number): number {
  let f = Math.asinh(m / e);
  for (let i = 0; i < 60; i++) f -= (e * Math.sinh(f) - f - m) / (e * Math.cosh(f) - 1);
  return f;
}

/** E with E − e·sin E = M (Newton). */
function solveElliptic(m: number, e: number): number {
  let E = m;
  for (let i = 0; i < 60; i++) E -= (E - e * Math.sin(E) - m) / (1 - e * Math.cos(E));
  return E;
}

/** Times and orbits of the arrival; the starting distance comes from everything fitting in APPROACH_H. */
function arrivalDesign() {
  const r_llo = R_MOON_KM + LLO_ALT_KM;
  const r_pdi = R_MOON_KM + PDI_ALT_KM;
  const t_llo = LLO_REVS * 2 * Math.PI * Math.sqrt(r_llo ** 3 / MU_MOON);
  const a_doi = (r_llo + r_pdi) / 2;
  const t_doi = Math.PI * Math.sqrt(a_doi ** 3 / MU_MOON); // half ellipse: aposelene to periselene
  const t_pd = PD_MIN * 60;
  const t_app = APPROACH_H * 3600 - t_llo - t_doi - t_pd;
  const a_h = MU_MOON / V_INF_KM_S ** 2;
  const e_h = 1 + r_llo / a_h;
  const n_h = Math.sqrt(MU_MOON / a_h ** 3);
  const F = solveHyperbolic(n_h * t_app, e_h);
  return {
    r_llo,
    r_pdi,
    t_app,
    t_llo,
    t_doi,
    t_pd,
    a_h,
    e_h,
    n_h,
    r0: a_h * (e_h * Math.cosh(F) - 1),
    a_doi,
    e_doi: (r_llo - r_pdi) / (r_llo + r_pdi),
    n_doi: Math.sqrt(MU_MOON / a_doi ** 3),
    dth_pd: PD_RANGE_KM / R_MOON_KM,
  };
}

export const ARRIVAL = arrivalDesign();

export interface Phases {
  launchMs: number;
  injectionMs: number;
  lunarArrivalMs: number;
  landingMs: number;
}

export function phasesFor(arrivalMs: number, transitDays: number): Phases {
  const launchMs = arrivalMs - transitDays * DAY_MS;
  return { launchMs, injectionMs: launchMs + INJECTION_H * H_MS, lunarArrivalMs: arrivalMs - APPROACH_H * H_MS, landingMs: arrivalMs };
}

/** np.linspace(a, b, n, endpoint) */
function linspace(a: number, b: number, n: number, endpoint: boolean): number[] {
  const div = endpoint ? n - 1 : n;
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / div);
}

/** Instants (s from launch): denser where the curve changes fast (sample_times_s). */
export function sampleTimesS(ph: Phases): number[] {
  const total = (ph.landingMs - ph.launchMs) / 1000;
  const tInj = (ph.injectionMs - ph.launchMs) / 1000;
  const tLa = (ph.lunarArrivalMs - ph.launchMs) / 1000;
  const d = ARRIVAL;
  const tLoi = tLa + d.t_app;
  const tDoi = tLoi + d.t_llo;
  const tPdi = tDoi + d.t_doi;
  return [
    ...linspace(0, ASCENT_MIN * 60, 6, false),
    ...linspace(ASCENT_MIN * 60, tInj, 16, false),
    ...linspace(0, Math.PI / 2, 50, false).map((u) => tInj + (tLa - tInj) * (1 - Math.cos(u))),
    ...linspace(0, Math.PI / 2, 28, false).map((u) => tLa + d.t_app * Math.sin(u)),
    ...linspace(tLoi, tDoi, 24 * LLO_REVS, false),
    ...linspace(tDoi, tPdi, 16, false),
    ...linspace(0, Math.PI / 2, 25, true).map((u) => tPdi + (total - tPdi) * Math.sin(u)),
  ];
}

/**
 * Phase 4 (A5): position relative to the Moon in its body-fixed frame (MOON_ME), `dt` seconds from landing (≤ 0).
 * Polar plane through the site; θ measured from the site in the direction of motion, landing at θ = 0, oriented so
 * the hyperbola starts on the Earth's side.
 */
class Arrival {
  private d = ARRIVAL;
  private rSite: number;
  private sHat: V;
  private bHat: V;
  private thPdi: number;
  private thDoi: number;
  private thLoi: number;
  private kPd: number;

  constructor(siteBody: V, earthDirBody: V) {
    const d = this.d;
    this.rSite = norm(siteBody);
    const sHat = unit(siteBody);
    const ePerp = sub(earthDirBody, mul(sHat, dot(earthDirBody, sHat)));
    const aHat = unit(norm(ePerp) > 1e-9 ? ePerp : cross(sHat, [1, 0, 0]));
    this.thPdi = -d.dth_pd;
    this.thDoi = this.thPdi - Math.PI;
    this.thLoi = this.thDoi - 2 * Math.PI * LLO_REVS;
    const pH = d.a_h * (d.e_h ** 2 - 1);
    const nu0 = -Math.acos((pH / d.r0 - 1) / d.e_h);
    const sign = Math.sin(this.thLoi + nu0) >= 0 ? 1 : -1;
    this.sHat = sHat;
    this.bHat = mul(aHat, sign);
    const vPdi = Math.sqrt(MU_MOON * (2 / d.r_pdi - 1 / d.a_doi));
    this.kPd = ((vPdi / d.r_pdi) * d.t_pd) / d.dth_pd;
  }

  private at(theta: number, r: number): V {
    return mul(add(mul(this.sHat, Math.cos(theta)), mul(this.bHat, Math.sin(theta))), r);
  }

  relBody(dt: number): V {
    const d = this.d;
    const tPdi = -d.t_pd;
    const tDoi = tPdi - d.t_doi;
    const tLoi = tDoi - d.t_llo;
    if (dt >= tPdi) {
      // d. powered descent
      const tau = Math.min(1, (dt - tPdi) / d.t_pd);
      const theta = this.thPdi * (1 - tau) ** this.kPd;
      const r = this.rSite + (d.r_pdi - this.rSite) * (1 - smoothstep(tau));
      return this.at(theta, r);
    }
    if (dt >= tDoi) {
      // c. descent orbit, aposelene (M = π) to periselene (M = 2π)
      const e = d.e_doi;
      const E = solveElliptic(Math.PI + d.n_doi * (dt - tDoi), e);
      let nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
      nu = ((nu % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      return this.at(this.thDoi + (nu - Math.PI), d.a_doi * (1 - e * Math.cos(E)));
    }
    if (dt >= tLoi) {
      // b. low circular orbit after the capture burn
      return this.at(this.thLoi + Math.sqrt(MU_MOON / d.r_llo ** 3) * (dt - tLoi), d.r_llo);
    }
    // a. approach hyperbola, perilune at tLoi
    const F = solveHyperbolic(d.n_h * (dt - tLoi), d.e_h);
    const nu = 2 * Math.atan(Math.sqrt((d.e_h + 1) / (d.e_h - 1)) * Math.tanh(F / 2));
    return this.at(this.thLoi + nu, d.a_h * (d.e_h * Math.cosh(F) - 1));
  }
}

export interface TrajectorySite {
  id: string;
  lat: number;
  lon: number;
  elevation_m: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const stampOf = (ms: number) => formatInstant(ms).slice(0, 10).replaceAll("-", "");

/** trajectory/{id}.json (contract §11) for a site and an arrival day, from the scene ephemeris (build()). */
export function buildTrajectory(site: TrajectorySite, arrivalMs: number, ix: EphemerisIndex, transitDays = 3): Trajectory {
  const ph = phasesFor(arrivalMs, transitDays);
  // the Moon at the exact instant, like pipeline/spice_utils.utc_to_et (it used to truncate to the second, ~1 km off
  // in the descent, and this port copied it; A9 fixed both)
  const state = (ms: number) => sceneStateAt(ix, ms);
  const moonPos = (ms: number) => state(ms).moonKm as V;
  const tS = sampleTimesS(ph);
  const tInj = (ph.injectionMs - ph.launchMs) / 1000;
  const tLa = (ph.lunarArrivalMs - ph.launchMs) / 1000;
  const total = (ph.landingMs - ph.launchMs) / 1000;

  const padEcef = mul(observerPositionKm(PAD_LAT_DEG, PAD_LON_DEG, 0, 0), R_EARTH_KM / R_MOON_KM);
  const upLaunch = unit(rotate(state(ph.launchMs).earthQuat, padEcef) as V);
  const rPark = R_EARTH_KM + PARKING_ALT_KM;
  const laState = state(ph.lunarArrivalMs);
  const moonLa = laState.moonKm as V;
  // parking-orbit plane: holds the launch vertical and the direction to the Moon at arrival
  const normal = unit(cross(upLaunch, unit(moonLa)));
  const side = cross(normal, upLaunch);
  const tAsc = ASCENT_MIN * 60;
  const omega = Math.sqrt(MU_EARTH / rPark ** 3);
  const parking = (t: number): V => {
    const ang = omega * (t - tAsc);
    return mul(add(mul(upLaunch, Math.cos(ang)), mul(side, Math.sin(ang))), rPark);
  };
  const parkingVelDir = (t: number): V => {
    const ang = omega * (t - tAsc);
    return unit(add(mul(upLaunch, -Math.sin(ang)), mul(side, Math.cos(ang))));
  };

  // 4. arrival in the Moon's body-fixed frame; seen from the Moon the Earth is at −moonLa
  const arrival = new Arrival(observerPositionKm(site.lat, site.lon, site.elevation_m, 0), unit(rotate(conjugate(laState.moonQuat), mul(moonLa, -1)) as V));
  const arrivalJ2000 = (t: number): V => {
    const s = state(ph.launchMs + t * 1000);
    return add(s.moonKm as V, rotate(s.moonQuat, arrival.relBody(t - total)) as V);
  };

  const pInj = parking(tInj);
  const pLa = arrivalJ2000(tLa);
  const chord = norm(sub(pLa, pInj));
  const tan0 = mul(parkingVelDir(tInj), chord);
  // the transfer ends with the velocity at the start of the arrival (Moon + hyperbola): no apparent stop
  const tan1 = mul(sub(arrivalJ2000(tLa + 1), pLa), tLa - tInj);

  const pos: V[] = tS.map((t) => {
    const ms = ph.launchMs + t * 1000;
    if (t <= tAsc) {
      // 1. radial ascent (the pad turns with the Earth); direction and radius separately
      const up = unit(rotate(state(ms).earthQuat, padEcef) as V);
      const s = smoothstep(t / tAsc);
      return mul(slerpDir(up, parking(t), s), R_EARTH_KM + PARKING_ALT_KM * s);
    }
    if (t <= tInj) return parking(t); // 2. parking orbit
    if (t <= tLa) return hermite(pInj, tan0, pLa, tan1, (t - tInj) / (tLa - tInj)); // 3. transfer
    // 4. arrival: approach, capture, low orbit, descent; the last point exactly on the site
    if (t === total) {
      const s = state(ms);
      return add(moonPos(ms), rotate(s.moonQuat, observerPositionKm(site.lat, site.lon, site.elevation_m, 0)) as V);
    }
    return arrivalJ2000(t);
  });

  const iso = (ms: number) => formatInstant(ms);
  return {
    id: `${site.id}_${stampOf(arrivalMs)}`,
    site_id: site.id,
    mode: MODE,
    frame: "J2000",
    t0_utc: iso(ph.launchMs),
    t_s: tS.map(r3), // to the millisecond: at ~1 km/s a 0.1 s rounding put the lander ~50 m off the site (A9)
    // A9: the last hour (the descent, which the camera follows from 0.8 km) to the metre, the rest to 0.1 km
    pos_km: pos.map((p, i) => p.map(tS[i] >= tS[tS.length - 1] - 3600 ? r3 : r1)),
    phases: { launch_utc: iso(ph.launchMs), injection_utc: iso(ph.injectionMs), lunar_arrival_utc: iso(ph.lunarArrivalMs), landing_utc: iso(ph.landingMs) },
  };
}
