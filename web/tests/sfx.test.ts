/** A4: mission-control cues. When they play (crossing an event while playing forward) and when they stay silent. */
import { describe, expect, it } from "vitest";
import type { MissionTimeline } from "../src/lib/mission";
import { crossedCues, MissionSfx, TELEMETRY_MIN_GAP_MS, type SfxContext } from "../src/lib/sfx";

const H = 3_600_000;
const L = Date.parse("2027-01-08T12:00:00Z");
const tl: MissionTimeline = {
  startMs: L - 5 * 60_000,
  launchMs: L,
  injectionMs: L + 3 * H,
  lunarArrivalMs: L + 75 * H,
  landingMs: L + 78 * H,
  endMs: L + 78 * H + 7 * 24 * H,
};

/** Every cue met by playing the mission from the countdown to the end in steps of `step`. */
function play(step: number): string[] {
  const out: string[] = [];
  for (let t = tl.startMs; t < tl.endMs; t += step) out.push(...crossedCues(tl, t, Math.min(t + step, tl.endMs)));
  return out;
}

describe("crossedCues: which moments the playback crossed", () => {
  it("a whole mission played at 6 h/s (60 fps) meets each cue in order: 3 beeps, lift-off, telemetry, orbit, touchdown", () => {
    const cues = play(0.1 * H); // 6 min of mission per frame
    expect(cues.slice(0, 4)).toEqual(["beep", "beep", "beep", "liftoff"]);
    expect(cues.filter((c) => c === "telemetry")).toHaveLength(5); // at 12, 24, 36, 48 and 60 h of a 72 h transit
    expect(cues.slice(-2)).toEqual(["orbit", "contact"]);
    expect(play(1000)).toEqual(cues); // the same at a much finer step: nothing doubled, nothing missed
  });

  it("a long frame on the approach still plays both moments; going backwards or standing still plays none", () => {
    expect(crossedCues(tl, tl.lunarArrivalMs - 4 * H, tl.landingMs + 1)).toEqual(["orbit", "contact"]);
    expect(crossedCues(tl, tl.landingMs + 1, tl.landingMs - 1)).toEqual([]);
    expect(crossedCues(tl, tl.launchMs, tl.launchMs)).toEqual([]);
    expect(crossedCues(tl, tl.launchMs - 1, tl.launchMs)).toEqual(["liftoff"]);
  });

  it("no telemetry outside the transit", () => {
    expect(crossedCues(tl, tl.landingMs, tl.landingMs + 5 * H)).toEqual([]); // at the site
    expect(crossedCues(tl, tl.launchMs + 1, tl.injectionMs)).toEqual([]); // ascent
  });
});

/** A fake audio context that counts the nodes and the scheduled starts. */
function fakeCtx() {
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ connect: (n: unknown) => n });
  const log = { oscillators: 0, sources: 0, buffers: 0 };
  const ctx = {
    currentTime: 1,
    sampleRate: 8000,
    destination: {},
    createOscillator: () => (log.oscillators++, { ...node(), type: "sine", frequency: param(), start() {}, stop() {} }),
    createGain: () => ({ ...node(), gain: param() }),
    createBiquadFilter: () => ({ ...node(), type: "lowpass", frequency: param() }),
    createBuffer: (_c: number, n: number) => (log.buffers++, { getChannelData: () => new Float32Array(n) }),
    createBufferSource: () => (log.sources++, { ...node(), buffer: null, loop: false, start() {}, stop() {} }),
  };
  return { ctx: ctx as unknown as SfxContext, log };
}

describe("MissionSfx: the button, reduced motion and the throttle", () => {
  it("plays through the shared context; silent when sound is off or not allowed yet", () => {
    const { ctx, log } = fakeCtx();
    let on = true;
    const s = new MissionSfx(() => (on ? ctx : null), () => false, () => 0);
    expect(s.play("contact")).toBe(true);
    expect(log.oscillators).toBe(3); // three touchdown beeps
    expect(s.play("liftoff")).toBe(true);
    expect(log.sources).toBe(1); // the rumble: one noise source…
    expect(log.buffers).toBe(1); // …from a buffer made once
    s.play("liftoff");
    expect(log.buffers).toBe(1);
    on = false;
    expect(s.play("beep")).toBe(false);
  });

  it("silent with reduced motion", () => {
    const { ctx, log } = fakeCtx();
    const s = new MissionSfx(() => ctx, () => true, () => 0);
    for (const c of ["beep", "liftoff", "telemetry", "orbit", "contact"] as const) expect(s.play(c)).toBe(false);
    expect(log.oscillators + log.sources).toBe(0);
  });

  it("telemetry blips no more often than every 1.5 s of real time, whatever the speed", () => {
    const { ctx } = fakeCtx();
    let now = 0;
    const s = new MissionSfx(() => ctx, () => false, () => now);
    expect(s.play("telemetry")).toBe(true);
    now += TELEMETRY_MIN_GAP_MS - 1;
    expect(s.play("telemetry")).toBe(false);
    now += 1;
    expect(s.play("telemetry")).toBe(true);
    expect(s.play("orbit")).toBe(true); // the other cues are not throttled
  });
});
