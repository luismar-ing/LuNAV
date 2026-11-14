/**
 * Geometry and timing behind the Mission Planner's Moon map and site brief (planner redesign, REDIS + 3C):
 * where a site falls on the published polar illumination map, how far apart two sites are, and how long until
 * the Sun or the Earth next drops behind the terrain (or comes back) from the site's one-year visibility series.
 */
import { parseInstant, type Timeseries } from "./contract";

/** Reference sphere of the LOLA products and of the illumination map's projection (1737.4 km). */
export const MOON_RADIUS_M = 1_737_400;

/** Extent of a south polar stereographic map, in metres (pipeline/illumination_map.py, south_avg.json). */
export interface MapExtent {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/**
 * South polar stereographic coordinates (m) of a latitude / longitude, true scale at the pole, on the 1737.4 km
 * sphere: the inverse of scene3d/terrain.polarToLonLat (x = ρ·sin λ, y = ρ·cos λ).
 */
export function polarXY(latDeg: number, lonDeg: number): [number, number] {
  const c = ((90 + latDeg) * Math.PI) / 180; // angular distance from the south pole
  const rho = 2 * MOON_RADIUS_M * Math.tan(c / 2);
  const lon = (lonDeg * Math.PI) / 180;
  return [rho * Math.sin(lon), rho * Math.cos(lon)];
}

/** Position on the map image as fractions of its width and height (0,0 = top left); outside the map → < 0 or > 1. */
export function mapFraction(ext: MapExtent, latDeg: number, lonDeg: number): { fx: number; fy: number } {
  const [x, y] = polarXY(latDeg, lonDeg);
  return { fx: (x - ext.left) / (ext.right - ext.left), fy: (ext.top - y) / (ext.top - ext.bottom) };
}

/** Great-circle distance (km) between two points on the 1737.4 km sphere. */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180;
  const cos = Math.sin(a.lat * r) * Math.sin(b.lat * r) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.cos((a.lon - b.lon) * r);
  return (MOON_RADIUS_M / 1000) * Math.acos(Math.min(1, Math.max(-1, cos)));
}

const POINTS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"] as const;

/** Compass point (8 winds) of an azimuth measured from local north, clockwise. */
export function compass(azDeg: number): (typeof POINTS)[number] {
  return POINTS[Math.round((((azDeg % 360) + 360) % 360) / 45) % 8];
}

/** Sample of a timeseries at an instant (floor), or −1 / n outside it. */
export function sampleIndex(ts: Pick<Timeseries, "start_utc" | "step_min" | "n">, ms: number): number {
  const k = Math.floor((ms - parseInstant(ts.start_utc)) / (ts.step_min * 60_000));
  return Math.max(-1, Math.min(ts.n, k));
}

export interface Change {
  /** visibility at the starting sample (1 = above the terrain) */
  visible: boolean;
  /** hours from the start to the first sample with the other state; null = no change before the series ends */
  hours: number | null;
  /** how long the other state lasts once it starts (h); null when it runs past the end of the series */
  lastsH: number | null;
}

/** Next change of a visibility flag from sample `k` (Sun or Earth above the terrain), and how long it lasts. */
export function nextChange(vis: ArrayLike<number>, k: number, stepMin: number): Change | null {
  if (k < 0 || k >= vis.length) return null;
  const v = vis[k];
  let j = k;
  while (j < vis.length && vis[j] === v) j++;
  if (j >= vis.length) return { visible: v === 1, hours: null, lastsH: null };
  let e = j;
  while (e < vis.length && vis[e] !== v) e++;
  return { visible: v === 1, hours: ((j - k) * stepMin) / 60, lastsH: e >= vis.length ? null : ((e - j) * stepMin) / 60 };
}

/** A duration as the planner shows it: "5 d 14 h" from a day up, "18 h 30 m" or "2 h" below. */
export function fmtDuration(hours: number): string {
  const min = Math.max(0, Math.round(hours * 60));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return m ? `${h} h ${m} m` : `${h} h`;
  return `${m} m`;
}

/** An instant as "16 Jan, 14:00 UTC". */
export function fmtUtc(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${day}, ${d.toISOString().slice(11, 16)} UTC`;
}
