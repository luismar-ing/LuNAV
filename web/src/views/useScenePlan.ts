import { useEffect, useRef, useState } from "react";
import type { Plan } from "../lib/contract";
import { timelineOf, type MissionTimeline } from "../lib/mission";
import { sceneBridge } from "../scene3d/bridge";
import { appStore } from "../store/appStore";

/**
 * The plan's mission timeline, and the mounted 3D scene kept on that plan (trajectory, timeline and site) when it
 * changes. The scene reads the selected plan itself when it mounts, so the plan selected at mount is already shown.
 */
export function useScenePlan(plan: Plan | undefined): MissionTimeline | null {
  const [timeline, setTimeline] = useState<MissionTimeline | null>(null);
  const shown = useRef<string | null>(appStore.getState().selectedPlanId);

  useEffect(() => {
    if (!plan) return;
    let alive = true;
    void appStore
      .getState()
      .data.trajectory(plan.trajectory_id)
      .then((traj) => {
        if (!alive) return;
        const tl = timelineOf(plan, traj);
        setTimeline(tl);
        if (shown.current !== plan.id && sceneBridge.setPlan) {
          sceneBridge.setPlan({ trajectory: traj, timeline: tl, siteId: plan.site_id });
          shown.current = plan.id;
        }
      });
    return () => {
      alive = false;
    };
  }, [plan]);

  return timeline;
}
