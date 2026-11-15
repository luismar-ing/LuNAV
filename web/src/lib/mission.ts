/**
 * Mission timeline of the selected plan (spec 8.2, 5.8): from launch to the end of the stay at the site.
 * Phase boundaries come from the trajectory file (contract §11): launch → injection → lunar arrival → landing
 * (= arrival_utc) → end of the window (arrival + L days).
 */
import type { Plan, Trajectory } from "./contract";
import { parseInstant } from "./contract";
import type { MissionPhase } from "../store/appStore";

/** Illustrative countdown on the pad before launch_utc (T4.2.b); the mission view starts there. */
export const PRELAUNCH_MS = 5 * 60_000;

export interface MissionTimeline {
  startMs: number; // start of the countdown = launch − PRELAUNCH_MS
  launchMs: number; // launch_utc (T+ 0)
  injectionMs: number;
  lunarArrivalMs: number;
  landingMs: number; // = arrival_utc
  endMs: number; // landing + window_days
}

/** The four playable phases, in order (the store's "overview" means "not started yet"). */
export const PLAY_PHASES = ["launch", "transit", "landing", "site"] as const satisfies readonly MissionPhase[];
export type PlayPhase = (typeof PLAY_PHASES)[number];

export function timelineOf(plan: Plan, traj: Trajectory): MissionTimeline {
  const p = traj.phases;
  return {
    startMs: parseInstant(p.launch_utc) - PRELAUNCH_MS,
    launchMs: parseInstant(p.launch_utc),
    injectionMs: parseInstant(p.injection_utc),
    lunarArrivalMs: parseInstant(p.lunar_arrival_utc),
    landingMs: parseInstant(p.landing_utc),
    endMs: parseInstant(plan.arrival_utc) + plan.window_days * 86_400_000,
  };
}

export function clampMission(tl: MissionTimeline, t: number): number {
  return Math.min(tl.endMs, Math.max(tl.startMs, t));
}

/** Phase at an instant: launch [countdown start, injection), transit [injection, lunar arrival), landing [lunar arrival, landing), site [landing, end]. */
export function phaseAt(tl: MissionTimeline, t: number): PlayPhase {
  if (t < tl.injectionMs) return "launch";
  if (t < tl.lunarArrivalMs) return "transit";
  if (t < tl.landingMs) return "landing";
  return "site";
}

/** Instant a "jump to phase" goes to: the start of that phase. */
export function phaseStart(tl: MissionTimeline, phase: PlayPhase): number {
  return { launch: tl.startMs, transit: tl.injectionMs, landing: tl.lunarArrivalMs, site: tl.landingMs }[phase];
}

/**
 * Mission elapsed time from launch: "T− 00:04:30" during the countdown (minutes:seconds), "T+ 2d 04:30"
 * afterwards (days hours:minutes), and the UTC instant "2027-01-01 00:00 UTC".
 */
export function missionClock(tl: MissionTimeline, t: number): { elapsed: string; utc: string } {
  const iso = new Date(t).toISOString();
  const utc = `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  if (t < tl.launchMs) {
    const s = Math.ceil((tl.launchMs - t) / 1000);
    return { elapsed: `T− ${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`, utc };
  }
  const min = Math.floor((t - tl.launchMs) / 60_000);
  const d = Math.floor(min / 1440);
  const hh = String(Math.floor((min % 1440) / 60)).padStart(2, "0");
  const mm = String(min % 60).padStart(2, "0");
  return { elapsed: `T+ ${d}d ${hh}:${mm}`, utc };
}

/**
 * Slow motion around launch (T5.2.a). At the usual 6 h/s the countdown and the lift-off would last a fraction
 * of a second on screen, so playback runs at LAUNCH_SLOW_RATE (mission seconds per real second) until launch_utc
 * and then speeds up exponentially to the chosen speed over LAUNCH_RAMP_MS of mission time. Rates are mission
 * milliseconds per real millisecond; slower chosen speeds are never slowed further.
 */
export const LAUNCH_SLOW_RATE = 300; // 5 minutes of mission per second: the 5-minute countdown takes 1 s
export const LAUNCH_RAMP_MS = 30 * 60_000;
/** Detailed launch (T6.3.a): 2 minutes of mission per second during the ascent, so the staging can be seen. */
export const ASCENT_SLOW_RATE = 120;

/**
 * A9: slow motion around the landing too, so the powered descent (its last 12 minutes) and the touchdown can be
 * followed: playback eases down from the chosen speed over LANDING_RAMP_MS, holds LANDING_SLOW_RATE from
 * LANDING_HOLD_MS before landing (when the camera catches up with the lander) until LANDING_AFTER_MS after it (the
 * camera settles on the site), then eases back up over LANDING_RAMP_MS.
 */
export const LANDING_SLOW_RATE = 90; // 1.5 min of mission per second: the 12-minute powered descent takes 8 s
export const LANDING_HOLD_MS = 16 * 60_000;
export const LANDING_AFTER_MS = 3 * 60_000;
export const LANDING_RAMP_MS = 40 * 60_000;

function landingRate(tl: MissionTimeline, t: number, full: number): number {
  if (full <= LANDING_SLOW_RATE) return full;
  const from = tl.landingMs - LANDING_HOLD_MS;
  const to = tl.landingMs + LANDING_AFTER_MS;
  if (t >= from && t <= to) return LANDING_SLOW_RATE;
  const u = (t < from ? from - t : t - to) / LANDING_RAMP_MS;
  return u >= 1 ? full : LANDING_SLOW_RATE * (full / LANDING_SLOW_RATE) ** u;
}

export function playbackRate(tl: MissionTimeline, t: number, hoursPerSecond: number, holdMs = 0): number {
  const full = hoursPerSecond * 3600;
  return Math.min(launchRate(tl, t, full, holdMs), landingRate(tl, t, full));
}

function launchRate(tl: MissionTimeline, t: number, full: number, holdMs: number): number {
  if (full <= LAUNCH_SLOW_RATE) return full;
  if (t < tl.launchMs) return LAUNCH_SLOW_RATE;
  // `holdMs` (the detailed launch's staging, T6.3.a): the ascent plays slower still for that long after launch,
  // and the ramp to full speed starts from there
  const base = holdMs > 0 ? ASCENT_SLOW_RATE : LAUNCH_SLOW_RATE;
  const from = tl.launchMs + holdMs;
  if (t < from) return base;
  const u = (t - from) / LAUNCH_RAMP_MS;
  return u >= 1 ? full : base * (full / base) ** u;
}
