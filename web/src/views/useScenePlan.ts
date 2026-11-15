import { useEffect, useRef, useState } from "react";
import type { Plan } from "../lib/contract";
import { timelineOf, type MissionTimeline } from "../lib/mission";
import { sceneBridge } from "../scene3d/bridge";
import { appStore } from "../store/appStore";

/** How often, and how many times, a plan chosen while the 3D scene is still loading is handed to it once ready. */
const RETRY_MS = 100;
const RETRIES = 300;

/**
 * The plan's mission timeline, and the mounted 3D scene kept on that plan (trajectory, timeline and site) when it
 * changes. The scene reads the selected plan itself when it starts mounting; a plan chosen after that, while the
 * scene is still loading (for example the Educator's best plan, picked as the view opens), is handed to the scene
 * as soon as it is ready. Before, the scene kept the plan it started with, so the rocket flew another day's
 * trajectory and did not lift off from the pad.
 */
export function useScenePlan(plan: Plan | undefined): MissionTimeline | null {
  const [timeline, setTimeline] = useState<MissionTimeline | null>(null);
  const shown = useRef<string | null>(appStore.getState().selectedPlanId);

  useEffect(() => {
    if (!plan) return;
    let alive = true;
    let timer = 0;
    void appStore
      .getState()
      .data.trajectory(plan.trajectory_id)
      .then((traj) => {
        if (!alive) return;
        const tl = timelineOf(plan, traj);
        setTimeline(tl);
        let tries = 0;
        const hand = () => {
          if (!alive || shown.current === plan.id) return;
          if (sceneBridge.setPlan) {
            sceneBridge.setPlan({ trajectory: traj, timeline: tl, siteId: plan.site_id });
            shown.current = plan.id;
          } else if (++tries < RETRIES) timer = window.setTimeout(hand, RETRY_MS); // the scene is still loading
        };
        hand();
      });
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [plan]);

  return timeline;
}
