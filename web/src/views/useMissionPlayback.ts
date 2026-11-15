import { useEffect, useState } from "react";
import { MAX_FRAME_MS, phaseAt, playbackRate, type MissionTimeline } from "../lib/mission";
import { ASCENT_MS } from "../scene3d/launch";
import { appStore } from "../store/appStore";

/** A stretch of the mission to play: up to `to` (epoch ms), at `hoursPerSecond` of mission time. */
export interface Playback {
  to: number;
  hoursPerSecond: number;
  /** at that speed all the way, without the slow motion around launch and landing ("Watch a full day") */
  steady?: boolean;
}

/**
 * Plays the mission clock (store missionTime and missionPhase) towards `play.to`, with the mission's slow motion
 * around launch (lib/mission playbackRate), and stops there. Shared by the Educator and the challenge (C3), which
 * drive the one 3D scene only through the store. `skip` jumps to the end of the stretch.
 */
export function useMissionPlayback(timeline: MissionTimeline | null) {
  const [play, setPlay] = useState<Playback | null>(null);

  useEffect(() => {
    if (!play || !timeline) return;
    let raf = 0;
    let last: number | null = null;
    const go = (t: number) => {
      appStore.getState().setMissionTime(t);
      appStore.getState().setMissionPhase(phaseAt(timeline, t));
    };
    const tick = (now: number) => {
      if (last !== null) {
        const cur = appStore.getState().missionTime ?? timeline.startMs;
        const hold = appStore.getState().detailedLaunch ? ASCENT_MS : 0; // staging stays watchable (T6.3.a)
        const rate = play.steady ? play.hoursPerSecond * 3600 : playbackRate(timeline, cur, play.hoursPerSecond, hold);
        const t = cur + Math.min(now - last, MAX_FRAME_MS) * rate; // a stalled frame never skips the slow parts (A9)
        if (t >= play.to) {
          go(play.to);
          // only this stretch: a chapter that just set the next one (Educator "Next chapter") keeps it playing
          setPlay((p) => (p === play ? null : p));
          return;
        }
        go(t);
      }
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [play, timeline]);

  const skip = () => {
    if (!play || !timeline) return;
    appStore.getState().setMissionTime(play.to);
    appStore.getState().setMissionPhase(phaseAt(timeline, play.to));
    setPlay(null);
  };

  return { play, setPlay, skip };
}
