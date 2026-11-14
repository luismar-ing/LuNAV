/**
 * Plain-language readings of a site's visibility series for the Mission Planner (planner redesign): the sentence
 * that sums up a plan, the Sun / Earth tracks over the stay, the countdowns and the list of what happens next.
 * Everything is built from the site's own one-year series and window metrics; nothing is made up to fill a gap.
 */
import type { Timeseries } from "./contract";
import { compass, fmtDuration, nextChange, sampleIndex, type Change } from "./moonMap";
import { num } from "./why";

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
  /** compass point of the Sun when it next sets (null if it does not set within the series, or is down now) */
  setDirection: string | null;
}

/** Sun and Earth state at an instant of a site's series. */
export function readAt(ts: Timeseries, ms: number): Reading {
  const k = sampleIndex(ts, ms);
  const sun = nextChange(ts.sun_vis, k, ts.step_min);
  const earth = nextChange(ts.earth_vis, k, ts.step_min);
  let setDirection: string | null = null;
  if (sun?.visible && sun.hours !== null) {
    const j = k + Math.round((sun.hours * 60) / ts.step_min) - 1; // last sample with the Sun up
    setDirection = compass(ts.sun_az[j] * ts.angle_scale);
  }
  return { k, sun, earth, setDirection };
}

/**
 * The sentence that sums up a plan, from the moment of landing: when the Sun goes (or comes back), the longest
 * night of the stay against the user's own limit (only when one is set), and the Earth.
 */
export function story(r: Reading, stayH: number, longestDarkH: number, limitH: number | null): string {
  const parts: string[] = [];
  const night = longestDarkH > 0 ? `The longest night of the stay lasts ${num(longestDarkH)} h${limitH !== null && longestDarkH > limitH ? `, ${num(longestDarkH - limitH)} h over your ${num(limitH)} h limit` : ""}.` : "";
  const sun = r.sun;
  if (!sun) return "";
  if (sun.visible && (sun.hours === null || sun.hours >= stayH)) {
    parts.push(sun.hours === null ? "The Sun stays up the whole stay." : `The Sun stays up the whole stay and sets ${fmtDuration(sun.hours)} after landing.`);
  } else if (sun.visible) {
    parts.push(`The Sun sets ${fmtDuration(sun.hours as number)} after landing, behind the terrain to the ${r.setDirection ?? "horizon"}.`);
    if (night) parts.push(night);
  } else {
    parts.push(sun.hours === null ? "You land in shadow, and the Sun does not come back within the data." : `You land in shadow; the Sun comes back ${fmtDuration(sun.hours)} later.`);
    if (night && longestDarkH > (sun.hours ?? 0)) parts.push(night);
  }
  const earth = r.earth;
  if (earth) {
    if (earth.visible && (earth.hours === null || earth.hours >= stayH)) parts.push("Earth stays in view the whole stay.");
    else if (earth.visible) parts.push(`Earth sets ${fmtDuration(earth.hours as number)} after landing.`);
    else parts.push(earth.hours === null ? "Earth stays below the skyline." : `Earth is below the skyline at landing and rises ${fmtDuration(earth.hours)} later.`);
  }
  return parts.join(" ");
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
