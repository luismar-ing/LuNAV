/**
 * "Find the best plan" (B11, decision A12): an exact search over every precomputed plan of one stay length.
 * With 5 sites × 365 arrival days per stay there is no need for a heuristic: every plan is checked against the
 * spec 5.6 constraints and the ones that pass are ranked by the spec 5.6 score, with fixed tie-breaks so the
 * answer is the same on every run. The score is normalised per stay length (pipeline/windows.py add_scores), so
 * plans of different stays are never ranked against each other.
 */
import { meetsConstraints, type WindowIndex } from "./constraints";
import type { WindowRow } from "./contract";
import type { Constraints } from "../store/appStore";

export type FinderOrder = "best" | "earliest";

export interface FinderQuery {
  constraints: Constraints;
  /** First and last arrival day allowed (YYYY-MM-DD, inclusive); null = the whole data range. */
  from: string | null;
  to: string | null;
  order: FinderOrder;
}

/** A run of consecutive arrival days at one site that all meet the limits. */
export interface DayRun {
  from: string;
  to: string;
  days: number;
}

export interface SiteResult {
  siteId: string;
  /** Plan id (`{site}_{YYYYMMDD}_{L}d`, as in plans.json). */
  planId: string;
  arrival: string; // YYYY-MM-DD
  row: WindowRow;
  /** Arrival days at this site that meet the limits (within the date range). */
  validDays: number;
  /** The run of consecutive valid days that holds the chosen day. */
  run: DayRun;
}

export interface SearchResult {
  windowDays: number;
  /** Plans looked at (sites × arrival days inside the date range). */
  evaluated: number;
  /** Plans that meet every limit. */
  valid: number;
  /** One result per site with at least one valid plan, best first. */
  bySite: SiteResult[];
}

const day = (r: WindowRow) => r.start.slice(0, 10);
export const planIdOf = (siteId: string, arrival: string, windowDays: number) => `${siteId}_${arrival.replace(/-/g, "")}_${windowDays}d`;

/**
 * Total order of plans, best first: score ↓, then sunlight ↓, longest dark ↑, mean Earth time ↓, longest comm
 * gap ↑ and, last, the earlier arrival. Many plans share a score of 1.00, so the tie-breaks matter.
 */
export function compareRows(a: WindowRow, b: WindowRow): number {
  return (
    b.score - a.score ||
    b.sun_pct - a.sun_pct ||
    a.longest_dark_h - b.longest_dark_h ||
    b.earth_h_mean - a.earth_h_mean ||
    a.longest_comm_gap_h - b.longest_comm_gap_h ||
    a.start.localeCompare(b.start)
  );
}

const inRange = (d: string, q: Pick<FinderQuery, "from" | "to">) => (q.from === null || d >= q.from) && (q.to === null || d <= q.to);

/** Exact search: every plan of the index is checked; returns the best plan of each site (see compareRows). */
export function search(index: WindowIndex, q: FinderQuery): SearchResult {
  let evaluated = 0;
  let valid = 0;
  const bySite: SiteResult[] = [];
  for (const siteId of index.siteIds) {
    const rows = index.rows[siteId];
    const ok = rows.map((r) => inRange(day(r), q) && meetsConstraints(r, q.constraints));
    let best = -1;
    let count = 0;
    rows.forEach((r, i) => {
      if (!inRange(day(r), q)) return;
      evaluated++;
      if (!ok[i]) return;
      count++;
      // rows are in arrival order: for "earliest" the first valid row wins
      if (best < 0 || (q.order === "best" && compareRows(r, rows[best]) < 0)) best = i;
    });
    valid += count;
    if (best < 0) continue;
    let lo = best;
    let hi = best;
    while (lo > 0 && ok[lo - 1]) lo--;
    while (hi < rows.length - 1 && ok[hi + 1]) hi++;
    const arrival = day(rows[best]);
    bySite.push({
      siteId,
      planId: planIdOf(siteId, arrival, index.windowDays),
      arrival,
      row: rows[best],
      validDays: count,
      run: { from: day(rows[lo]), to: day(rows[hi]), days: hi - lo + 1 },
    });
  }
  bySite.sort((a, b) => (q.order === "earliest" ? a.arrival.localeCompare(b.arrival) || compareRows(a.row, b.row) : compareRows(a.row, b.row)));
  return { windowDays: index.windowDays, evaluated, valid, bySite };
}

/** Plans that meet the limits for one stay length (the count shown for the other stays). */
export function countValid(index: WindowIndex, q: Pick<FinderQuery, "constraints" | "from" | "to">): number {
  let n = 0;
  for (const siteId of index.siteIds) for (const r of index.rows[siteId]) if (inRange(day(r), q) && meetsConstraints(r, q.constraints)) n++;
  return n;
}

export interface Relaxation {
  key: keyof Constraints;
  /** The best value of this metric among the plans that meet the OTHER limits (null: none meets them). */
  reachable: number | null;
  /** That value on the control's own step, so applying it gives at least one plan (null when reachable is). */
  suggested: number | null;
}

/** Control steps of ConstraintControls: sunlight 1 %, darkness 1 h, Earth 0.5 h/day. */
const SNAP: Record<keyof Constraints, (v: number) => number> = {
  minSunPct: (v) => Math.floor(v),
  maxDarkH: (v) => Math.ceil(v),
  minEarthH: (v) => Math.floor(v * 2) / 2,
};

/**
 * When nothing meets the limits: for each active limit, the best value reachable while keeping the others. All
 * exact, over the same rows; never a guess.
 */
export function relaxations(index: WindowIndex, q: Pick<FinderQuery, "constraints" | "from" | "to">): Relaxation[] {
  const keys = (Object.keys(q.constraints) as (keyof Constraints)[]).filter((k) => q.constraints[k] !== null);
  return keys.map((key) => {
    const others = { ...q.constraints, [key]: null };
    let reachable: number | null = null;
    for (const siteId of index.siteIds) {
      for (const r of index.rows[siteId]) {
        if (!inRange(day(r), q) || !meetsConstraints(r, others)) continue;
        const v = key === "minSunPct" ? r.sun_pct : key === "maxDarkH" ? r.longest_dark_h : r.earth_h_min;
        if (reachable === null || (key === "maxDarkH" ? v < reachable : v > reachable)) reachable = v;
      }
    }
    return { key, reachable, suggested: reachable === null ? null : SNAP[key](reachable) };
  });
}
