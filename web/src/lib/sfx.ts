/**
 * Mission-control sound cues (A4), synthesised with Web Audio like the ambient pad: no audio files. They play
 * only while the mission plays forward through an event (not on a jump or a scrub), only when the sound button
 * is on and the browser lets audio run (they share the pad's audio context), and never with "Reduce motion".
 * Nothing sounds like an engine in space: the only rumble is the lift-off, on Earth, where air carries it.
 * ILLUSTRATIVE, like the journey itself: they mark moments of the mission, they are not recordings of one.
 */
import { appStore } from "../store/appStore";
import { ambient } from "./ambient";
import type { MissionTimeline } from "./mission";

export type Cue = "beep" | "liftoff" | "telemetry" | "orbit" | "contact";

const MIN = 60_000;
const HOUR = 3_600_000;
/** Countdown beeps at T− 3, 2 and 1 minutes (the 5-minute countdown plays in about a second). */
export const COUNTDOWN_BEEPS_MS = [3 * MIN, 2 * MIN, MIN] as const;
/** A telemetry blip every 12 h of transit. */
export const TELEMETRY_EVERY_MS = 12 * HOUR;
/** Telemetry blips at most this often in real time, whatever the speed. */
export const TELEMETRY_MIN_GAP_MS = 1500;

/**
 * The cues whose moment the mission clock crossed going forward from `prev` to `now` (pure). Only the playback
 * loop calls it, frame by frame: a jump or a scrub moves the clock without it, so they never sound. A long frame
 * (the terrain loading on the approach) may cross several moments at once; they all play.
 */
export function crossedCues(tl: MissionTimeline, prev: number, now: number): Cue[] {
  if (!(now > prev)) return [];
  const crossed = (t: number) => prev < t && t <= now;
  const out: Cue[] = [];
  for (const before of COUNTDOWN_BEEPS_MS) if (crossed(tl.launchMs - before)) out.push("beep");
  if (crossed(tl.launchMs)) out.push("liftoff");
  // telemetry: every 12 h after injection, while in transit
  const k = Math.floor((now - tl.injectionMs) / TELEMETRY_EVERY_MS);
  const tk = tl.injectionMs + k * TELEMETRY_EVERY_MS;
  if (k >= 1 && tk < tl.lunarArrivalMs && crossed(tk)) out.push("telemetry");
  if (crossed(tl.lunarArrivalMs)) out.push("orbit");
  if (crossed(tl.landingMs)) out.push("contact");
  return out;
}

/** The part of the Web Audio API the cues use (tests pass a fake). */
export type SfxContext = Pick<BaseAudioContext, "currentTime" | "destination" | "sampleRate" | "createOscillator" | "createGain" | "createBiquadFilter" | "createBuffer" | "createBufferSource">;

const LEVEL = 0.22;

export class MissionSfx {
  private lastTelemetry = -Infinity;
  private noise: AudioBuffer | null = null;

  constructor(
    private readonly context: () => SfxContext | null,
    private readonly reducedMotion: () => boolean,
    private readonly nowMs: () => number = () => performance.now(),
  ) {}

  /** Play a cue now; returns false when it stays silent (sound off, not allowed yet, reduced motion, throttled). */
  play(cue: Cue): boolean {
    if (this.reducedMotion()) return false;
    const ctx = this.context();
    if (!ctx) return false;
    if (cue === "telemetry") {
      const now = this.nowMs();
      if (now - this.lastTelemetry < TELEMETRY_MIN_GAP_MS) return false;
      this.lastTelemetry = now;
    }
    const t = ctx.currentTime + 0.01;
    switch (cue) {
      case "beep":
        tone(ctx, 1000, t, 0.12, 0.5);
        break;
      case "telemetry":
        tone(ctx, 1400, t, 0.04, 0.18);
        tone(ctx, 1800, t + 0.07, 0.04, 0.18);
        break;
      case "orbit":
        tone(ctx, 660, t, 0.35, 0.4, "triangle");
        tone(ctx, 990, t + 0.18, 0.5, 0.4, "triangle");
        break;
      case "contact":
        [880, 1100, 1320].forEach((hz, i) => tone(ctx, hz, t + i * 0.13, 0.09, 0.45));
        break;
      case "liftoff":
        this.rumble(ctx, t);
        break;
    }
    return true;
  }

  /** Lift-off: low filtered noise that swells and fades as the rocket climbs, over a deep thump. */
  private rumble(ctx: SfxContext, t: number) {
    if (!this.noise) {
      const n = Math.floor(ctx.sampleRate * 2);
      this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      let last = 0;
      for (let i = 0; i < n; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; // brown noise: deep, without hiss
        d[i] = last * 3.5;
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(140, t);
    lp.frequency.linearRampToValueAtTime(420, t + 0.6);
    lp.frequency.linearRampToValueAtTime(160, t + 4.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(LEVEL * 3, t + 0.4);
    g.gain.exponentialRampToValueAtTime(0.001, t + 4.5);
    src.connect(lp).connect(g).connect(ctx.destination);
    src.start(t);
    src.stop(t + 4.6);
    tone(ctx, 45, t, 1.2, 1.2);
  }
}

/** One short tone with a soft attack and an exponential release. */
function tone(ctx: SfxContext, hz: number, t: number, dur: number, level: number, type: OscillatorType = "sine") {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(hz, t);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(LEVEL * level, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** The app's mission cues, on the ambient pad's audio context. */
export const sfx = new MissionSfx(
  () => ambient.liveContext as SfxContext | null,
  () => appStore.getState().reducedMotion,
);
