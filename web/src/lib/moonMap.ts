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

/** B12: the inverse of mapFraction: latitude and longitude (deg, longitude in [-180, 180)) of a point of the map image. */
export function fractionToLatLon(ext: MapExtent, fx: number, fy: number): { lat: number; lon: number } {
  const x = ext.left + fx * (ext.right - ext.left);
  const y = ext.top - fy * (ext.top - ext.bottom);
  const c = 2 * Math.atan(Math.hypot(x, y) / (2 * MOON_RADIUS_M));
  const lon = (Math.atan2(x, y) * 180) / Math.PI;
  return { lat: -90 + (c * 180) / Math.PI, lon: ((lon + 540) % 360) - 180 };
}

/** Great-circle distance (km) between two points on the 1737.4 km sphere. */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180;
  const cos = Math.sin(a.lat * r) * Math.sin(b.lat * r) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.cos((a.lon - b.lon) * r);
  return (MOON_RADIUS_M / 1000) * Math.acos(Math.min(1, Math.max(-1, cos)));
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

/** An instant as "Jan 16, 14:00 UTC": the app's one date format (B5, lib/format.ts). */
export { fmtUtc } from "./format";

/** A box in pixels (left, top, width, height). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LabelSide = "right" | "left" | "above" | "below";
/** Order of preference: beside the dot reads best, then above and below. */
export const LABEL_SIDES: LabelSide[] = ["right", "left", "above", "below"];

/** Where a label of size w × h goes for a dot at (cx, cy) on one side, `gap` px from the dot's centre. */
export function labelBox(cx: number, cy: number, w: number, h: number, side: LabelSide, gap = 14): Box {
  switch (side) {
    case "right":
      return { x: cx + gap, y: cy - h / 2, w, h };
    case "left":
      return { x: cx - gap - w, y: cy - h / 2, w, h };
    case "above":
      return { x: cx - w / 2, y: cy - gap - h, w, h };
    case "below":
      return { x: cx - w / 2, y: cy + gap, w, h };
  }
}

const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * Sides for the pin labels of the Moon map so that no two labels, a label and a fixed obstacle (the distance tag,
 * the dots) or a label and the edge of the map overlap (B9, finding H15: "52 km" over "Haworth"). Greedy, in the
 * order given (the chosen site first): each label takes the first side of LABEL_SIDES with no overlap, or the one
 * with the least.
 */
export function placeLabels(labels: { id: string; cx: number; cy: number; w: number; h: number }[], obstacles: Box[], bounds: Box): Record<string, LabelSide> {
  const placed: Box[] = [];
  const out: Record<string, LabelSide> = {};
  for (const l of labels) {
    let best: { side: LabelSide; cost: number; box: Box } | null = null;
    for (const side of LABEL_SIDES) {
      const box = labelBox(l.cx, l.cy, l.w, l.h, side);
      const outside = box.w * box.h - overlap(box, bounds);
      const cost = [...placed, ...obstacles].reduce((s, o) => s + overlap(box, o), 0) + outside;
      if (!best || cost < best.cost) best = { side, cost, box };
      if (cost === 0) break;
    }
    out[l.id] = best!.side;
    placed.push(best!.box);
  }
  return out;
}
