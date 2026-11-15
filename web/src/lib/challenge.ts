/**
 * "Can your lander make it?" (C3): the challenge at the end of the Educator's story. A mission fixes the month and
 * the length of the stay; the player picks a landing site and an arrival day, and learns at once whether an ASSUMED
 * lander (lib/energy.ts) keeps its power for the whole stay, and why.
 *
 * Nothing new is computed here: the battery and the night come from the same helpers as the Mission Planner's site
 * panel (lib/siteBrief.ts stayBattery and nightInStay) on the site's own one-year series, so a plan scores the same
 * in the challenge and in the planner.
 */
import { parseInstant, type Timeseries } from "./contract";
import { ASSUMED_BATTERY, batteryHours } from "./energy";
import { nightInStay, stayBattery } from "./siteBrief";

const DAY_MS = 86_400_000;

export interface ChallengeLevel {
  id: number;
  /** Month the arrival is chosen in, "YYYY-MM" (UTC). */
  month: string;
  /** Length of the stay, fixed by the mission. */
  stayDays: number;
}

/**
 * Level 1: survive a week in March 2027. With the real data a blind pick works about half the time
 * (7-day stays that keep the assumed battery above empty: 23, 9, 12, 12 and 20 of 31 days, site by site), so the
 * site and the day both matter.
 */
export const LEVEL_1: ChallengeLevel = { id: 1, month: "2027-03", stayDays: 7 };

/** Arrival days of a level's month, as "YYYY-MM-DD" (UTC). */
export function monthDays(level: ChallengeLevel): string[] {
  const [y, m] = level.month.split("-").map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of the next month = last day of this one
  return Array.from({ length: n }, (_, i) => `${level.month}-${String(i + 1).padStart(2, "0")}`);
}

export interface ChallengeNight {
  /** Hours of the longest night that fall inside the stay. */
  inStayH: number;
  /** Its full length in the series (it may start before landing or end after leaving). */
  fullH: number;
  /** Day of the stay it starts on (1 = landing day); 1 as well when it began before landing. */
  startDay: number;
  /** The lander touched down in the dark. */
  beforeLanding: boolean;
}

export interface ChallengeResult {
  /** The assumed battery never ran empty during the stay. */
  success: boolean;
  /** Hours the assumed lander spent with an empty battery. */
  emptyH: number;
  /** Lowest state of charge over the stay (0 to 1). */
  minSoc: number;
  /** Hours of darkness a full battery lasts at the assumed load (capacity / load). */
  batteryH: number;
  /** Share of the stay with the Sun's upper limb above the terrain (%). */
  sunPct: number;
  /** The longest night of the stay; null when the Sun never sets. */
  night: ChallengeNight | null;
}

/** The outcome of landing at a site's series on `arrivalDay` ("YYYY-MM-DD") for `stayDays`; null outside the data. */
export function evaluate(ts: Timeseries, arrivalDay: string, stayDays: number): ChallengeResult | null {
  const arrivalMs = parseInstant(`${arrivalDay}T00:00:00Z`);
  const battery = stayBattery(ts, arrivalMs, stayDays);
  if (!battery) return null;
  const k0 = Math.round((arrivalMs - parseInstant(ts.start_utc)) / (ts.step_min * 60_000));
  const n = Math.round((stayDays * DAY_MS) / (ts.step_min * 60_000));
  let lit = 0;
  for (let k = k0; k < k0 + n; k++) lit += ts.sun_vis[k];
  const nn = nightInStay(ts, arrivalMs, stayDays * 24);
  const night: ChallengeNight | null = nn
    ? {
        inStayH: nn.inStayH,
        fullH: nn.fullH,
        startDay: Math.floor((Math.max(nn.startMs, arrivalMs) - arrivalMs) / DAY_MS) + 1,
        beforeLanding: nn.startMs < arrivalMs,
      }
    : null;
  return {
    success: battery.emptyH === 0,
    emptyH: battery.emptyH,
    minSoc: battery.minSoc,
    batteryH: batteryHours(ASSUMED_BATTERY),
    sunPct: (100 * lit) / n,
    night,
  };
}

/** Which arrival days of a level's month keep the lander alive at one site: revealed after each attempt. */
export function monthOutcomes(ts: Timeseries, level: ChallengeLevel): Record<string, boolean> {
  return Object.fromEntries(monthDays(level).map((d) => [d, evaluate(ts, d, level.stayDays)?.success ?? false]));
}
