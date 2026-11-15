/**
 * Plain-language readings of a site's visibility series for the Mission Planner (planner redesign): the Sun / Earth
 * tracks over the stay, the countdowns and the list of what happens next.
 * Everything is built from the site's own one-year series and window metrics; nothing is made up to fill a gap.
 */
import { parseInstant, type Timeseries, type WindowRow } from "./contract";
import { batteryRun } from "./energy";
import { nextChange, sampleIndex, type Change } from "./moonMap";

/** Sun over the stay: no night at all, or at least one stretch behind the terrain. */
export type SunState = "lit" | "night";
/** Earth over the stay: in view the whole time, with gaps, or never in view (no direct-to-Earth link). */
export type EarthState = "all" | "gaps" | "none";

/**
 * How a plan fares for energy AND direct Earth contact (B2, finding H6), from its window row only.
 * good = no night and no loss of Earth; poor = no Earth at all, or a night together with Earth gaps; mixed = the rest.
 * Strict on purpose: any night or any gap counts (no tolerance invented here).
 */
export interface Verdict {
  sun: SunState;
  earth: EarthState;
  tone: "good" | "mixed" | "poor";
  /** longest night inside the stay (h) */
  darkH: number;
  /** longest stretch without the Earth inside the stay (h) */
  gapH: number;
}

export function planVerdict(row: Pick<WindowRow, "longest_dark_h" | "earth_h_mean" | "longest_comm_gap_h">): Verdict {
  const sun: SunState = row.longest_dark_h === 0 ? "lit" : "night";
  const earth: EarthState = row.longest_comm_gap_h === 0 ? "all" : row.earth_h_mean === 0 ? "none" : "gaps";
  const tone = sun === "lit" && earth === "all" ? "good" : earth === "none" || (sun === "night" && earth === "gaps") ? "poor" : "mixed";
  return { sun, earth, tone, darkH: row.longest_dark_h, gapH: row.longest_comm_gap_h };
}

/** A stretch of the stay, as fractions of it (0..1), where a body is above the terrain. */
export interface Span {
  from: number;
  to: number;
}

/**
 * The longest night inside a stay, and the whole night it belongs to (B3, finding H8). The window metric
 * `longest_dark_h` is the longest dark run of the year clipped to the stay (pipeline/windows.py,
 * longest_run_in_windows); the countdowns read the same run unclipped. Both figures come from here so they can be
 * shown together ("34 h of a 36.5 h night") instead of as two unrelated numbers.
 */
export interface StayNight {
  /** hours of that night inside the stay: equals the window's longest_dark_h */
  inStayH: number;
  /** hours of the whole night, before and after the stay included */
  fullH: number;
  /** false when the night runs into the start or end of the one-year series, so fullH is a lower bound */
  fullKnown: boolean;
  /** instants (ms) where the whole night starts and ends */
  startMs: number;
  endMs: number;
}

/** Longest night clipped to [startMs, startMs + stayH) and its full extent in the series; null when the stay has no night. */
export function nightInStay(ts: Pick<Timeseries, "start_utc" | "step_min" | "n" | "sun_vis">, startMs: number, stayH: number): StayNight | null {
  const k0 = Math.max(0, sampleIndex(ts, startMs));
  const k1 = Math.min(ts.n, k0 + Math.round((stayH * 60) / ts.step_min));
  let best: { inStay: number; a: number; b: number } | null = null;
  let k = k0;
  while (k < k1) {
    if (ts.sun_vis[k] !== 0) {
      k++;
      continue;
    }
    let a = k; // the whole run, outside the stay too
    while (a > 0 && ts.sun_vis[a - 1] === 0) a--;
    let b = k;
    while (b < ts.n && ts.sun_vis[b] === 0) b++;
    const inStay = Math.min(b, k1) - Math.max(a, k0);
    if (!best || inStay > best.inStay) best = { inStay, a, b };
    k = b;
  }
  if (!best) return null;
  const h = ts.step_min / 60;
  const t0 = parseInstant(ts.start_utc);
  const stepMs = ts.step_min * 60_000;
  return {
    inStayH: best.inStay * h,
    fullH: (best.b - best.a) * h,
    fullKnown: best.a > 0 && best.b < ts.n,
    startMs: t0 + best.a * stepMs,
    endMs: t0 + best.b * stepMs,
  };
}

/**
 * A countdown kept inside the stay (B4, finding H9). The one-year series can put the next sunset or Earthset weeks
 * away; a 7-day stay should then read "up all stay", with the real date only as a side note.
 */
export interface StayChange {
  /** the change happens before the stay ends: show the countdown */
  withinStay: boolean;
  /** hours from now to the change (null: not in the data) */
  hours: number | null;
  /** when it happens (ms), even after the stay; null when not in the data */
  atMs: number | null;
}

export function stayChange(change: Change, nowMs: number, stayEndMs: number): StayChange {
  const atMs = change.hours === null ? null : nowMs + change.hours * 3_600_000;
  return { withinStay: atMs !== null && atMs < stayEndMs, hours: change.hours, atMs };
}

/**
 * The ASSUMED battery over a stay (B7, finding H16): lib/energy.ts batteryRun on the site's own sunlight, sliced
 * exactly like the tray's plan window (planData.sliceWindow), so the planner and the tray show the same figure.
 */
export function stayBattery(ts: Pick<Timeseries, "start_utc" | "step_min" | "n" | "sun_vis">, startMs: number, stayDays: number): { minSoc: number; emptyH: number } | null {
  const step = ts.step_min * 60_000;
  const k0 = Math.round((startMs - parseInstant(ts.start_utc)) / step);
  const n = Math.round((stayDays * 86_400_000) / step);
  if (k0 < 0 || k0 + n > ts.n) return null;
  const run = batteryRun(ts.sun_vis.slice(k0, k0 + n), ts.step_min);
  return { minSoc: run.minSoc, emptyH: (run.emptySamples * ts.step_min) / 60 };
}

/** Hours of the night [nightStartMs, nightEndMs) that fall inside the stay [stayStartMs, stayEndMs). */
export function overlapH(nightStartMs: number, nightEndMs: number, stayStartMs: number, stayEndMs: number): number {
  return Math.max(0, Math.min(nightEndMs, stayEndMs) - Math.max(nightStartMs, stayStartMs)) / 3_600_000;
}

/** Runs of visibility over `n` samples from `k`, as fractions of the stay. */
export function visibleSpans(vis: ArrayLike<number>, k: number, n: number): Span[] {
  const out: Span[] = [];
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && k + i < vis.length && vis[k + i] === 1;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      out.push({ from: start / n, to: i / n });
      start = -1;
    }
  }
  return out;
}

export interface Reading {
  /** sample of the series at the instant read */
  k: number;
  sun: Change | null;
  earth: Change | null;
}

/** Sun and Earth state at an instant of a site's series. */
export function readAt(ts: Timeseries, ms: number): Reading {
  const k = sampleIndex(ts, ms);
  const sun = nextChange(ts.sun_vis, k, ts.step_min);
  const earth = nextChange(ts.earth_vis, k, ts.step_min);
  return { k, sun, earth };
}

export type EventKind = "sunset" | "sunrise" | "earthset" | "earthrise" | "end";

export interface MissionEvent {
  kind: EventKind;
  atMs: number;
  /** after the end of the stay */
  afterStay: boolean;
  /** for "end": the Sun is down when the stay ends */
  inDark?: boolean;
}

/**
 * What happens next from an instant: the next two changes of the Sun, the next change of the Earth and the end of
 * the stay, in time order, within `horizonDays`.
 */
export function upcoming(ts: Timeseries, nowMs: number, endMs: number, horizonDays = 30): MissionEvent[] {
  const r = readAt(ts, nowMs);
  const out: MissionEvent[] = [];
  const at = (h: number) => nowMs + h * 3_600_000;
  if (r.sun?.hours != null) {
    out.push({ kind: r.sun.visible ? "sunset" : "sunrise", atMs: at(r.sun.hours), afterStay: false });
    if (r.sun.lastsH !== null) out.push({ kind: r.sun.visible ? "sunrise" : "sunset", atMs: at(r.sun.hours + r.sun.lastsH), afterStay: false });
  }
  if (r.earth?.hours != null) out.push({ kind: r.earth.visible ? "earthset" : "earthrise", atMs: at(r.earth.hours), afterStay: false });
  if (endMs > nowMs) {
    const kEnd = Math.min(ts.n - 1, sampleIndex(ts, endMs - 1));
    out.push({ kind: "end", atMs: endMs, afterStay: false, inDark: kEnd >= 0 ? ts.sun_vis[kEnd] === 0 : undefined });
  }
  return out
    .filter((e) => e.atMs <= nowMs + horizonDays * 86_400_000)
    .map((e) => ({ ...e, afterStay: e.kind !== "end" && e.atMs > endMs }))
    .sort((a, b) => a.atMs - b.atMs);
}
