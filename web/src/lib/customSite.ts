/**
 * Custom coordinates (B12, decision A13). Any point from 85°S to the pole:
 *  - the Sun and the Earth seen from it, from sky/moon_me.bin (Sun and Earth relative to the Moon centre, MOON_ME,
 *    LT+S, every 30 min; pipeline/custom_site.py), minus the observer position, in its local East-North-Up frame,
 *    as pipeline/ephemeris.py does for the five sites;
 *  - the terrain horizon traced from the exact coordinate over the LOLA DEM reduced to 160 m near the point and
 *    400 m beyond 10 km (terrain_custom/; pipeline/custom_site.py), measured against the 40 m masks of the five
 *    candidate sites (tests/customSite.test.ts);
 *  - the spec 5.3 / 5.4 visibility flags and the spec 5.5 window metrics, ported from pipeline/visibility.py and
 *    pipeline/windows.py (same rules, so the five sites give their published numbers back: tests/customSite.test.ts).
 */
import type { WindowRow } from "./contract";

export const MOON_R_M = 1_737_400;
const R_REF_KM = 1737.4;
const DEG = Math.PI / 180;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- data

export interface SkyHeader {
  start_utc: string;
  step_min: number;
  n: number;
  frame: string;
  abcorr: string;
}
/** Sun and Earth positions (km, MOON_ME, from the Moon centre): [sample][sun xyz, earth xyz]. */
export interface SkyData {
  header: SkyHeader;
  startMs: number;
  vec: Float32Array;
}
export function parseSky(header: SkyHeader, bin: ArrayBuffer): SkyData {
  const vec = new Float32Array(bin);
  if (vec.length !== header.n * 6) throw new Error(`sky/moon_me.bin holds ${vec.length} values, expected ${header.n * 6}`);
  return { header, startMs: Date.parse(header.start_utc), vec };
}

/** One level of the reduced LOLA relief (terrain_custom/): heights on a square grid centred on the pole. */
export interface TerrainLevelHeader {
  bin_file: string;
  byte_length: number;
  nx: number;
  ny: number;
  spacing_m: number;
  x0_m: number; // outer corner of the top-left pixel
  y0_m: number;
}
export interface CustomTerrainHeader {
  lat_limit_deg: number;
  near_m: number;
  r_max_km: number;
  h_obs_m: number;
  az_step_deg: number;
  height_scale_m: number;
  dem_product: string;
  fine: TerrainLevelHeader;
  coarse: TerrainLevelHeader;
}
export interface TerrainLevel {
  header: TerrainLevelHeader;
  z: Float32Array;
}
export interface CustomTerrain {
  header: CustomTerrainHeader;
  fine: TerrainLevel;
  coarse: TerrainLevel;
}
export function parseLevel(header: TerrainLevelHeader, bin: ArrayBuffer, scale: number): TerrainLevel {
  const ints = new Int16Array(bin);
  if (ints.length !== header.nx * header.ny) throw new Error(`${header.bin_file} holds ${ints.length} heights, expected ${header.nx * header.ny}`);
  const z = new Float32Array(ints.length);
  for (let i = 0; i < ints.length; i++) z[i] = ints[i] * scale;
  return { header, z };
}

// ---------------------------------------------------------------- geometry

/** South polar stereographic of the DEM (R = 1737.4 km, true scale at the pole): +y towards 0°E, +x towards 90°E. */
export function latLonToPolar(latDeg: number, lonDeg: number): [number, number] {
  const rho = 2 * MOON_R_M * Math.tan(Math.PI / 4 + (latDeg * DEG) / 2);
  return [rho * Math.sin(lonDeg * DEG), rho * Math.cos(lonDeg * DEG)];
}
export function polarToLatLon(x: number, y: number): [number, number] {
  const c = 2 * Math.atan(Math.hypot(x, y) / (2 * MOON_R_M));
  const lon = Math.atan2(x, y) / DEG;
  return [-90 + c / DEG, ((lon + 540) % 360) - 180];
}

/** Great-circle distance (m) on the reference sphere. */
export function surfaceDistanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
  return 2 * MOON_R_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Bilinear height on pixel centres; NaN outside (pipeline/custom_site.py Level.sample). */
export function sampleLevel(lv: TerrainLevel, x: number, y: number): number {
  const h = lv.header;
  const col = (x - h.x0_m) / h.spacing_m - 0.5;
  const row = (h.y0_m - y) / h.spacing_m - 0.5;
  const c0 = Math.floor(col);
  const r0 = Math.floor(row);
  if (c0 < 0 || r0 < 0 || c0 + 1 >= h.nx || r0 + 1 >= h.ny) return NaN;
  const fc = col - c0;
  const fr = row - r0;
  const k = r0 * h.nx + c0;
  const z = lv.z;
  return z[k] * (1 - fc) * (1 - fr) + z[k + 1] * fc * (1 - fr) + z[k + h.nx] * (1 - fc) * fr + z[k + h.nx + 1] * fc * fr;
}

export interface PointHorizon {
  /** Terrain height at the point (m above the 1737.4 km sphere), from the fine level. */
  elevationM: number;
  /** Horizon elevation (deg) at azimuth i · az_step_deg. */
  mask: Float64Array;
}

/**
 * Spec 5.2 horizon mask traced from the exact coordinate (pipeline/custom_site.py hybrid_mask, horizon.compute_mask):
 * great circles on the 1737.4 km sphere with local azimuth, the fine level (160 m) up to near_m (10 km) and the
 * coarse level (400 m) up to R_max (100 km); elev = atan2(z(d) − z0 − h_obs − d²/2R, d). Null outside 85°S.
 */
export function horizonFrom(t: CustomTerrain, lat: number, lon: number): PointHorizon | null {
  const h = t.header;
  if (lat > h.lat_limit_deg || lat < -90) return null;
  const [px, py] = latLonToPolar(lat, lon);
  const z0 = sampleLevel(t.fine, px, py);
  if (Number.isNaN(z0)) return null;
  const nAz = Math.round(360 / h.az_step_deg);
  const mask = new Float64Array(nAz).fill(-90);
  const p1 = lat * DEG;
  const sp1 = Math.sin(p1);
  const cp1 = Math.cos(p1);
  const rMax = h.r_max_km * 1000;
  const legs: [TerrainLevel, number, number][] = [
    [t.fine, t.fine.header.spacing_m, Math.floor(h.near_m / t.fine.header.spacing_m)],
    [t.coarse, t.coarse.header.spacing_m, Math.floor((rMax - h.near_m) / t.coarse.header.spacing_m)],
  ];
  for (let a = 0; a < nAz; a++) {
    const th = a * h.az_step_deg * DEG;
    const sth = Math.sin(th);
    const cth = Math.cos(th);
    let best = -90;
    for (let leg = 0; leg < 2; leg++) {
      const [lv, step, count] = legs[leg];
      const d0 = leg === 0 ? 0 : h.near_m;
      for (let i = 1; i <= count; i++) {
        const d = d0 + i * step;
        const dl = d / MOON_R_M;
        const sd = Math.sin(dl);
        const cd = Math.cos(dl);
        const sp2 = sp1 * cd + cp1 * sd * cth;
        const lat2 = Math.asin(sp2);
        const lon2 = lon * DEG + Math.atan2(sth * sd * cp1, cd - sp1 * sp2);
        const rho = 2 * MOON_R_M * Math.tan(Math.PI / 4 + lat2 / 2);
        const z = sampleLevel(lv, rho * Math.sin(lon2), rho * Math.cos(lon2));
        if (Number.isNaN(z)) return null;
        const el = Math.atan2(z - z0 - h.h_obs_m - (d * d) / (2 * MOON_R_M), d);
        if (el > best) best = el;
      }
    }
    mask[a] = best / DEG;
  }
  return { elevationM: z0, mask };
}

// ---------------------------------------------------------------- the sky from a point

export interface SkySeries {
  startMs: number;
  stepMin: number;
  n: number;
  sunAz: Float64Array;
  sunEl: Float64Array;
  earthAz: Float64Array;
  earthEl: Float64Array;
}

/**
 * Azimuth (from local north towards east) and elevation of the Sun and the Earth from a point at `elevationM`
 * above the 1737.4 km sphere, observer `hObsM` higher (pipeline/ephemeris.py observer_position_km, enu_basis).
 */
export function skyFrom(sky: SkyData, lat: number, lon: number, elevationM: number, hObsM = 3): SkySeries {
  const n = sky.header.n;
  const r = R_REF_KM + (elevationM + hObsM) / 1000;
  const sl = Math.sin(lat * DEG);
  const cl = Math.cos(lat * DEG);
  const so = Math.sin(lon * DEG);
  const co = Math.cos(lon * DEG);
  const obs = [r * cl * co, r * cl * so, r * sl];
  const E = [-so, co, 0];
  const N = [-sl * co, -sl * so, cl];
  const U = [cl * co, cl * so, sl];
  const out = { startMs: sky.startMs, stepMin: sky.header.step_min, n, sunAz: new Float64Array(n), sunEl: new Float64Array(n), earthAz: new Float64Array(n), earthEl: new Float64Array(n) };
  const v = sky.vec;
  for (let k = 0; k < n; k++) {
    for (let body = 0; body < 2; body++) {
      const o = k * 6 + body * 3;
      const dx = v[o] - obs[0];
      const dy = v[o + 1] - obs[1];
      const dz = v[o + 2] - obs[2];
      const e = dx * E[0] + dy * E[1] + dz * E[2];
      const nn = dx * N[0] + dy * N[1] + dz * N[2];
      const u = dx * U[0] + dy * U[1] + dz * U[2];
      const az = ((Math.atan2(e, nn) / DEG) % 360 + 360) % 360;
      const el = Math.atan2(u, Math.hypot(e, nn)) / DEG;
      if (body === 0) {
        out.sunAz[k] = az;
        out.sunEl[k] = el;
      } else {
        out.earthAz[k] = az;
        out.earthEl[k] = el;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- visibility (spec 5.3, 5.4)

/** Mask elevation at any azimuth: linear between bins, wrapping 359° → 0° (pipeline/visibility.py horizon_at). */
export function horizonAt(mask: ArrayLike<number>, azDeg: number, azStepDeg = 1): number {
  const n = mask.length;
  const pos = (((azDeg % 360) + 360) % 360) / azStepDeg;
  const i0 = Math.floor(pos) % n;
  const f = pos - Math.floor(pos);
  return mask[i0] * (1 - f) + mask[(i0 + 1) % n] * f;
}

export interface VisibilityParams {
  sunRadiusDeg: number;
  antennaMarginDeg: number;
  azStepDeg: number;
}

export function visibility(s: SkySeries, mask: ArrayLike<number>, p: VisibilityParams): { sun: Uint8Array; earth: Uint8Array } {
  const sun = new Uint8Array(s.n);
  const earth = new Uint8Array(s.n);
  for (let k = 0; k < s.n; k++) {
    sun[k] = s.sunEl[k] + p.sunRadiusDeg > horizonAt(mask, s.sunAz[k], p.azStepDeg) ? 1 : 0;
    earth[k] = s.earthEl[k] > horizonAt(mask, s.earthAz[k], p.azStepDeg) + p.antennaMarginDeg ? 1 : 0;
  }
  return { sun, earth };
}

// ---------------------------------------------------------------- window metrics (spec 5.5; pipeline/windows.py)

/** Runs of 0 in the flags: [start, end) pairs, in samples. */
function zeroRuns(flags: Uint8Array): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let k = 0; k <= flags.length; k++) {
    const zero = k < flags.length && flags[k] === 0;
    if (zero && start < 0) start = k;
    else if (!zero && start >= 0) {
      runs.push([start, k]);
      start = -1;
    }
  }
  return runs;
}

/** Longest run of 0 inside [s, s + length), each run of the whole series clipped to the window (longest_run_in_windows). */
function longestInWindow(runs: [number, number][], s: number, length: number): number {
  let best = 0;
  for (const [a, b] of runs) {
    if (a >= s + length) break;
    best = Math.max(best, Math.min(b, s + length) - Math.max(a, s));
  }
  return best;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The spec 5.5 metrics of every arrival day (00:00 UTC from the series start) for one stay length, without the
 * score: the score is normalised over the five sites (pipeline/windows.py add_scores) and means nothing for a lone
 * point. Rounded to 2 decimals like the published windows.
 */
export function windowRows(sun: Uint8Array, earth: Uint8Array, startMs: number, stepMin: number, nArrivals: number, windowDays: number): Omit<WindowRow, "score">[] {
  const spd = 1440 / stepMin;
  const h = stepMin / 60;
  const length = windowDays * spd;
  if (sun.length < (nArrivals - 1 + windowDays) * spd) throw new Error("the series is too short for these arrivals");
  const csum = new Int32Array(sun.length + 1);
  for (let k = 0; k < sun.length; k++) csum[k + 1] = csum[k] + sun[k];
  const nDays = Math.floor(sun.length / spd);
  const earthDay = new Float64Array(nDays);
  for (let d = 0; d < nDays; d++) {
    let c = 0;
    for (let k = d * spd; k < (d + 1) * spd; k++) c += earth[k];
    earthDay[d] = c * h;
  }
  const darkRuns = zeroRuns(sun);
  const gapRuns = zeroRuns(earth);
  const rows: Omit<WindowRow, "score">[] = [];
  for (let d = 0; d < nArrivals; d++) {
    const s = d * spd;
    let min = Infinity;
    let sum = 0;
    for (let i = d; i < d + windowDays; i++) {
      min = Math.min(min, earthDay[i]);
      sum += earthDay[i];
    }
    rows.push({
      start: new Date(startMs + d * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z"),
      sun_pct: r2((100 * (csum[s + length] - csum[s])) / length),
      longest_dark_h: r2(longestInWindow(darkRuns, s, length) * h),
      earth_h_min: r2(min),
      earth_h_mean: r2(sum / windowDays),
      longest_comm_gap_h: r2(longestInWindow(gapRuns, s, length) * h),
    });
  }
  return rows;
}

/** Everything the custom-site panel needs for one coordinate and one stay length. */
export interface CustomSiteResult {
  lat: number;
  lon: number;
  point: PointHorizon;
  sky: SkySeries;
  sun: Uint8Array;
  earth: Uint8Array;
  rows: Omit<WindowRow, "score">[];
}

export function analyseCustomSite(
  sky: SkyData,
  terrain: CustomTerrain,
  lat: number,
  lon: number,
  windowDays: number,
  nArrivals: number,
  p: Omit<VisibilityParams, "azStepDeg">,
): CustomSiteResult | null {
  const point = horizonFrom(terrain, lat, lon);
  if (!point) return null;
  const s = skyFrom(sky, lat, lon, point.elevationM, terrain.header.h_obs_m);
  const vis = visibility(s, point.mask, { ...p, azStepDeg: terrain.header.az_step_deg });
  return { lat, lon, point, sky: s, ...vis, rows: windowRows(vis.sun, vis.earth, s.startMs, s.stepMin, nArrivals, windowDays) };
}

/** Parses "-89.4, -137.1", "89.4S 137.1W", "89.4°S, 137.1°W" and similar. Returns null when it cannot. */
export function parseCoordinates(text: string): { lat: number; lon: number } | null {
  const parts = text
    .toUpperCase()
    .replace(/[°º]/g, " ")
    .split(/[,;]|\s+(?=[-+]?\d)/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length !== 2) return null;
  const read = (p: string, pos: string, neg: string): number | null => {
    const m = /^([-+]?\d+(?:\.\d+)?)\s*([A-Z])?$/.exec(p.replace(/\s+/g, " "));
    if (!m) return null;
    let v = Number(m[1]);
    if (m[2] === neg) v = -Math.abs(v);
    else if (m[2] && m[2] !== pos) return null;
    return v;
  };
  const lat = read(parts[0], "N", "S");
  const lon = read(parts[1], "E", "W");
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 360) return null;
  // longitudes east of 180° (e.g. 222.9°E) are written west (-137.1°), rounded to the input's precision
  return { lat, lon: lon >= -180 && lon < 180 ? lon : Number((((((lon + 180) % 360) + 360) % 360) - 180).toFixed(9)) };
}
