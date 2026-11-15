/**
 * Virtual site (B13, decision A14): a custom coordinate turned into a site like the five candidates, so the whole
 * journey (launch, transit, landing and the site) runs on it unchanged. Every file a site has is produced here, in
 * the contract's own shapes (validated by the DataStore with the same zod schemas):
 *   horizon, timeseries, daily, windows  ← lib/customSite (SPICE vectors + the horizon traced over the reduced relief)
 *   score                                ← pipeline/windows.py add_scores, on the five sites' scale, clipped to [0, 1]
 *   site_features                        ← the coordinate, the ground height, and the official named features near it
 *   terrain lod0 / lod1                  ← pipeline/terrain_lod.py surface_up_m over the reduced relief (no 40 m lod2)
 *   trajectory                           ← lib/trajectoryBuilder (ILLUSTRATIVE, built from the scene ephemeris)
 * Everything is APPROXIMATE where it comes from the reduced relief, and the trajectory is ILLUSTRATIVE as always.
 */
import type { DayRowSchema, Horizon, Manifest, Plan, Site, SiteFeatures, TerrainHeader, Timeseries, Trajectory, WindowRow, Windows } from "./contract";
import { formatInstant } from "./contract";
import { horizonFrom, latLonToPolar, MOON_R_M, sampleLevel, skyFrom, surfaceDistanceM, visibility, windowRows, type CustomTerrain, type SkySeries } from "./customSite";
import type { DataStore } from "./data";
import { buildTrajectory } from "./trajectoryBuilder";
import { indexEphemeris } from "../scene3d/ephemeris";
import type { z } from "zod";

type DayRow = z.infer<typeof DayRowSchema>;
const DAY_MS = 86_400_000;
const DEG = Math.PI / 180;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Prefix of every virtual site id: real ids never start with it. */
export const CUSTOM_PREFIX = "custom_";

/** Site id of a coordinate (contract SiteId: [a-z0-9_]): one id per point, so the DataStore cache never mixes two. */
export function customSiteId(lat: number, lon: number): string {
  const q = (v: number) => String(Math.round(Math.abs(v) * 10_000));
  return `${CUSTOM_PREFIX}${lat < 0 ? "s" : "n"}${q(lat)}_${lon < 0 ? "w" : "e"}${q(lon)}`;
}

export const isCustomSiteId = (id: string | null | undefined): boolean => !!id && id.startsWith(CUSTOM_PREFIX);

// ---------------------------------------------------------------- plans

/** One plan per arrival day and stay length, with the same ids as the five sites (contract §5). */
export function virtualPlans(siteId: string, m: Pick<Manifest, "date_range" | "params">): Plan[] {
  const first = Date.parse(`${m.date_range.arrival_start}T00:00:00Z`);
  const last = Date.parse(`${m.date_range.arrival_end}T00:00:00Z`);
  const plans: Plan[] = [];
  for (let t = first; t <= last; t += DAY_MS) {
    const iso = formatInstant(t);
    const stamp = iso.slice(0, 10).replaceAll("-", "");
    for (const L of m.params.window_days) {
      plans.push({
        id: `${siteId}_${stamp}_${L}d`,
        site_id: siteId,
        arrival_utc: iso,
        window_days: L,
        transit_days: m.params.transit_days,
        launch_utc: formatInstant(t - m.params.transit_days * DAY_MS),
        trajectory_id: `${siteId}_${stamp}`,
      });
    }
  }
  return plans;
}

// ---------------------------------------------------------------- timeseries and daily (contract §7, §8)

/** Contract §7: angles quantised to 0.01° integers (pipeline/build_all.py timeseries_json). */
export function toTimeseries(siteId: string, s: SkySeries, sun: Uint8Array, earth: Uint8Array): Timeseries {
  const q = (a: Float64Array) => Array.from(a, (v) => Math.round(v / 0.01));
  const az = (a: Float64Array) => Array.from(a, (v) => ((Math.round(v / 0.01) % 36000) + 36000) % 36000);
  return {
    site_id: siteId,
    start_utc: formatInstant(s.startMs),
    step_min: s.stepMin,
    n: s.n,
    angle_scale: 0.01,
    sun_az: az(s.sunAz),
    sun_el: q(s.sunEl),
    earth_az: az(s.earthAz),
    earth_el: q(s.earthEl),
    sun_vis: Array.from(sun),
    earth_vis: Array.from(earth),
  };
}

function longestRun(flags: Uint8Array, from: number, to: number, value: number): number {
  let best = 0;
  let run = 0;
  for (let k = from; k < to; k++) {
    run = flags[k] === value ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** Per UTC day aggregates, streaks cut at midnight (pipeline/windows.py daily_aggregates). */
export function dailyRows(startMs: number, stepMin: number, sun: Uint8Array, earth: Uint8Array): DayRow[] {
  const spd = 1440 / stepMin;
  const h = stepMin / 60;
  const rows: DayRow[] = [];
  for (let d = 0; d < Math.floor(sun.length / spd); d++) {
    const a = d * spd;
    const b = a + spd;
    let s = 0;
    let e = 0;
    for (let k = a; k < b; k++) {
      s += sun[k];
      e += earth[k];
    }
    rows.push({
      date: formatInstant(startMs + d * DAY_MS).slice(0, 10),
      sun_pct: r2((100 * s) / spd),
      earth_h: r2(e * h),
      longest_dark_h: r2(longestRun(sun, a, b, 0) * h),
      longest_comm_gap_h: r2(longestRun(earth, a, b, 0) * h),
    });
  }
  return rows;
}

// ---------------------------------------------------------------- score (spec 5.6) on the five sites' scale

export interface ScoreScale {
  sun: [number, number];
  dark: [number, number];
  earth: [number, number];
}

/** Range of each scored metric over every row of the five sites for one stay length (what add_scores normalises over). */
export function scoreScale(rowsBySite: WindowRow[][] | Omit<WindowRow, "score">[][]): ScoreScale {
  const range = (pick: (r: Omit<WindowRow, "score">) => number): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const rows of rowsBySite)
      for (const r of rows) {
        const v = pick(r);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    return [lo, hi];
  };
  return { sun: range((r) => r.sun_pct), dark: range((r) => r.longest_dark_h), earth: range((r) => r.earth_h_mean) };
}

/**
 * score = (w1·norm(sun_pct) + w2·(1 − norm(longest_dark_h)) + w3·norm(earth_h_mean)) / (w1 + w2 + w3), with norm on
 * the five sites' range (pipeline/windows.py add_scores) and clipped to [0, 1]: a point better than every candidate
 * scores 1 on that metric, never more. Rounded to 4 decimals like the published windows.
 */
export function scoreRow(r: Omit<WindowRow, "score">, s: ScoreScale, w: { w1: number; w2: number; w3: number }): number {
  const norm = (v: number, [lo, hi]: [number, number]) => (hi === lo ? 0.5 : Math.min(1, Math.max(0, (v - lo) / (hi - lo))));
  const score = (w.w1 * norm(r.sun_pct, s.sun) + w.w2 * (1 - norm(r.longest_dark_h, s.dark)) + w.w3 * norm(r.earth_h_mean, s.earth)) / (w.w1 + w.w2 + w.w3);
  return Math.round(score * 10_000) / 10_000;
}

// ---------------------------------------------------------------- terrain (contract §13)

export const VIRTUAL_LODS = [
  { lod: 0, half_m: 60_000, spacing_m: 300 },
  { lod: 1, half_m: 20_000, spacing_m: 100 },
] as const;

/** Reduced relief at a polar stereographic point: the 160 m level, the 400 m one where the first ends. */
function reliefAt(t: CustomTerrain, x: number, y: number): number {
  const z = sampleLevel(t.fine, x, y);
  return Number.isNaN(z) ? sampleLevel(t.coarse, x, y) : z;
}

/**
 * ENU_SITE level (pipeline/terrain_lod.py surface_up_m): node (x, y) is the surface point at geodesic distance
 * hypot(x, y) and azimuth atan2(x, y) from the site; its height is the site's "Up" coordinate relative to the site
 * elevation, curvature drop included. Heights from the reduced relief (APPROXIMATE): only lod0 and lod1 exist.
 */
export function terrainLevel(t: CustomTerrain, site: Pick<Site, "id" | "lat" | "lon" | "elevation_m">, lod: number): { header: TerrainHeader; heights: Float32Array } {
  const spec = VIRTUAL_LODS.find((l) => l.lod === lod);
  if (!spec) throw new Error(`no lod${lod} for a custom site (the 40 m level exists only at the five candidate sites)`);
  const n = Math.round((2 * spec.half_m) / spec.spacing_m) + 1;
  const heights = new Float32Array(n * n);
  const p1 = site.lat * DEG;
  const sp1 = Math.sin(p1);
  const cp1 = Math.cos(p1);
  const r0 = MOON_R_M + site.elevation_m;
  for (let row = 0; row < n; row++) {
    const y = spec.half_m - row * spec.spacing_m;
    for (let col = 0; col < n; col++) {
      const x = -spec.half_m + col * spec.spacing_m;
      const d = Math.hypot(x, y);
      const th = Math.atan2(x, y);
      const dl = d / MOON_R_M;
      const sd = Math.sin(dl);
      const cd = Math.cos(dl);
      const sp2 = sp1 * cd + cp1 * sd * Math.cos(th);
      const lat2 = Math.asin(sp2);
      const lon2 = site.lon * DEG + Math.atan2(Math.sin(th) * sd * cp1, cd - sp1 * sp2);
      const [px, py] = latLonToPolar(lat2 / DEG, lon2 / DEG);
      const h = reliefAt(t, px, py);
      heights[row * n + col] = Number.isNaN(h) ? 0 : (MOON_R_M + h) * Math.cos(dl) - r0;
    }
  }
  return {
    header: {
      site_id: site.id,
      lod,
      frame: "ENU_SITE",
      origin: { lat: site.lat, lon: site.lon, elevation_m: site.elevation_m },
      projection: null,
      grid: { nx: n, ny: n, spacing_m: spec.spacing_m, x0_m: -spec.half_m, y0_m: spec.half_m },
      height_encoding: "int16",
      height_scale_m: 0.5,
      height_offset_m: 0,
      bin_file: `lod${lod}.bin`,
      byte_length: n * n * 2,
    },
    heights,
  };
}

// ---------------------------------------------------------------- site features (contract §12)

export function customFeatures(site: Site, demProduct: string, others: SiteFeatures[]): SiteFeatures {
  const coordSource = "Coordinate chosen by the user (custom coordinates)";
  const near = new Map<string, SiteFeatures["nearby_features"][number]>();
  for (const f of others.flatMap((o) => o.nearby_features)) {
    if (near.has(f.name)) continue;
    near.set(f.name, { ...f, distance_km: r2(surfaceDistanceM(site.lat, site.lon, f.lat, f.lon) / 1000) });
  }
  const notAvailable = (key: string, label: string, unit: string, method: string) => ({ key, label, value: null, unit, status: "not available" as const, source: null, method });
  return {
    site_id: site.id,
    attributes: [
      { key: "lat", label: "Latitude", value: site.lat, unit: "deg", status: "available", source: coordSource, method: "Planetocentric latitude" },
      { key: "lon", label: "Longitude", value: site.lon, unit: "deg", status: "available", source: coordSource, method: "East longitude, -180 to 180" },
      {
        key: "elevation_m",
        label: "Elevation",
        value: Math.round(site.elevation_m * 10) / 10,
        unit: "m",
        status: "available",
        source: demProduct,
        method: "Height above the 1737.4 km reference sphere, from the LOLA relief reduced to 160 m (APPROXIMATE)",
      },
      notAvailable("slope_mean_deg", "Mean slope", "deg", "Needs the 40 m DEM, shipped only for the five candidate sites"),
      notAvailable("slope_max_deg", "Max slope", "deg", "Needs the 40 m DEM, shipped only for the five candidate sites"),
    ],
    // the official named features already verified for the five sites (IAU/USGS gazetteer), nearest first
    nearby_features: [...near.values()].sort((a, b) => a.distance_km - b.distance_km).slice(0, 3),
  };
}

// ---------------------------------------------------------------- the provider

export interface VirtualSiteProvider {
  site: Site;
  horizon(): Promise<Horizon>;
  timeseries(): Promise<Timeseries>;
  daily(): Promise<{ site_id: string; days: DayRow[] }>;
  windows(windowDays: number): Promise<Windows>;
  siteFeatures(): Promise<SiteFeatures>;
  terrain(lod: number): Promise<{ header: TerrainHeader; heights: Float32Array }>;
  trajectory(arrivalMs: number): Promise<Trajectory>;
}

/**
 * Builds the virtual site of a coordinate: null outside the reduced relief (north of 85°S). The heavy part (horizon,
 * a year of Sun and Earth flags) runs once here; the rest is computed when a view asks for it.
 */
export async function createVirtualSite(data: DataStore, lat: number, lon: number): Promise<{ site: Site; plans: Plan[]; provider: VirtualSiteProvider } | null> {
  const [manifest, sky, terrain] = await Promise.all([data.getManifest(), data.sky(), data.terrainCustom()]);
  const point = horizonFrom(terrain, lat, lon);
  if (!point) return null;
  const id = customSiteId(lat, lon);
  const p = manifest.params;
  const site: Site = {
    id,
    name: `Custom site · ${lat.toFixed(3)}°, ${lon.toFixed(3)}°`,
    lat,
    lon,
    elevation_m: Math.round(point.elevationM * 10) / 10,
    source: `Custom coordinate; elevation from ${terrain.header.dem_product}, reduced to 160 m (APPROXIMATE)`,
  };
  const series = skyFrom(sky, lat, lon, point.elevationM, terrain.header.h_obs_m);
  const vis = visibility(series, point.mask, { sunRadiusDeg: p.sun_radius_deg, antennaMarginDeg: p.antenna_margin_deg, azStepDeg: terrain.header.az_step_deg });
  const nArrivals = Math.round((Date.parse(manifest.date_range.arrival_end) - Date.parse(manifest.date_range.arrival_start)) / DAY_MS) + 1;

  const provider: VirtualSiteProvider = {
    site,
    horizon: async () => ({
      site_id: id,
      az_step_deg: terrain.header.az_step_deg,
      h_obs_m: terrain.header.h_obs_m,
      r_max_km: terrain.header.r_max_km,
      elev_deg: Array.from(point.mask, (v) => Math.round(v * 1000) / 1000),
    }),
    timeseries: async () => toTimeseries(id, series, vis.sun, vis.earth),
    daily: async () => ({ site_id: id, days: dailyRows(series.startMs, series.stepMin, vis.sun, vis.earth) }),
    windows: async (L) => {
      const real = await Promise.all(manifest.sites.map((s) => data.windows(s, L)));
      const scale = scoreScale(real.map((w) => w.rows));
      const rows = windowRows(vis.sun, vis.earth, series.startMs, series.stepMin, nArrivals, L).map((r) => ({ ...r, score: scoreRow(r, scale, p.score_weights) }));
      return { site_id: id, window_days: L, rows };
    },
    siteFeatures: async () => {
      const others = await Promise.all(manifest.sites.map((s) => data.siteFeatures(s).catch(() => null)));
      return customFeatures(site, terrain.header.dem_product, others.filter((o): o is SiteFeatures => o !== null));
    },
    terrain: async (lod) => terrainLevel(terrain, site, lod),
    trajectory: async (arrivalMs) => buildTrajectory(site, arrivalMs, indexEphemeris(await data.scene()), p.transit_days),
  };
  return { site, plans: virtualPlans(id, manifest), provider };
}
