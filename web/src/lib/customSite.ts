/**
 * Custom coordinates (B12, decision A13). Any point from 85°S to the pole:
 *  - the Sun and the Earth seen from it, from sky/moon_me.bin (Sun and Earth relative to the Moon centre, MOON_ME,
 *    LT+S, every 30 min; pipeline/horizon_grid.py), minus the observer position, in its local East-North-Up frame,
 *    as pipeline/ephemeris.py does for the five sites;
 *  - the terrain horizon of the nearest point of a 5 km grid of masks computed with the 40 m LOLA DEM
 *    (horizon_grid/), with its distance stated: the horizon is that point's, not the exact coordinate's;
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

export interface GridHeader {
  grid: { nx: number; ny: number; spacing_m: number; x0_m: number; y0_m: number; lat_limit_deg: number; r_max_m: number };
  points: number;
  az_step_deg: number;
  n_az: number;
  h_obs_m: number;
  r_max_km: number;
  encoding: { scale_deg: number; nodata: number };
  z0_m: (number | null)[];
  dem_product: string;
}
export interface GridData {
  header: GridHeader;
  masks: Int16Array;
}
export function parseGrid(header: GridHeader, bin: ArrayBuffer): GridData {
  const masks = new Int16Array(bin);
  const { nx, ny } = header.grid;
  if (masks.length !== nx * ny * header.n_az) throw new Error(`horizon_grid/masks.bin holds ${masks.length} values, expected ${nx * ny * header.n_az}`);
  return { header, masks };
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

export interface GridPoint {
  index: number;
  lat: number;
  lon: number;
  elevationM: number;
  distanceM: number;
  /** Horizon elevation (deg) at azimuth i · az_step_deg. */
  mask: Float64Array;
}

/** Nearest grid point that has a mask, or null when the coordinate is outside the grid (north of 85°S). */
export function nearestGridPoint(grid: GridData, lat: number, lon: number): GridPoint | null {
  const { grid: g, n_az, encoding, z0_m } = grid.header;
  if (lat > g.lat_limit_deg || lat < -90) return null;
  const [x, y] = latLonToPolar(lat, lon);
  if (Math.hypot(x, y) > g.r_max_m + g.spacing_m / 2) return null;
  const i0 = Math.round((x - g.x0_m) / g.spacing_m);
  const j0 = Math.round((g.y0_m - y) / g.spacing_m);
  let best: { k: number; d: number } | null = null;
  // the rounded cell, or a neighbour when it lies just outside the circle of computed points
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const i = i0 + di;
      const j = j0 + dj;
      if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue;
      const k = j * g.nx + i;
      if (z0_m[k] === null || grid.masks[k * n_az] === encoding.nodata) continue;
      const d = Math.hypot(g.x0_m + i * g.spacing_m - x, g.y0_m - j * g.spacing_m - y);
      if (!best || d < best.d) best = { k, d };
    }
  }
  if (!best) return null;
  const px = g.x0_m + (best.k % g.nx) * g.spacing_m;
  const py = g.y0_m - Math.floor(best.k / g.nx) * g.spacing_m;
  const [plat, plon] = polarToLatLon(px, py);
  const mask = new Float64Array(n_az);
  for (let a = 0; a < n_az; a++) mask[a] = grid.masks[best.k * n_az + a] * encoding.scale_deg;
  return { index: best.k, lat: plat, lon: plon, elevationM: z0_m[best.k]!, distanceM: surfaceDistanceM(lat, lon, plat, plon), mask };
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
  point: GridPoint;
  sky: SkySeries;
  sun: Uint8Array;
  earth: Uint8Array;
  rows: Omit<WindowRow, "score">[];
}

export function analyseCustomSite(
  sky: SkyData,
  grid: GridData,
  lat: number,
  lon: number,
  windowDays: number,
  nArrivals: number,
  p: Omit<VisibilityParams, "azStepDeg">,
): CustomSiteResult | null {
  const point = nearestGridPoint(grid, lat, lon);
  if (!point) return null;
  const s = skyFrom(sky, lat, lon, point.elevationM, grid.header.h_obs_m);
  const vis = visibility(s, point.mask, { ...p, azStepDeg: grid.header.az_step_deg });
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
