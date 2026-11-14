/**
 * Plain-language readings of a site's visibility series for the Mission Planner (planner redesign): the Sun / Earth
 * tracks over the stay, the countdowns and the list of what happens next.
 * Everything is built from the site's own one-year series and window metrics; nothing is made up to fill a gap.
 */
import type { Timeseries } from "./contract";
import { nextChange, sampleIndex, type Change } from "./moonMap";

/** A stretch of the stay, as fractions of it (0..1), where a body is above the terrain. */
export interface Span {
  from: number;
  to: number;
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
