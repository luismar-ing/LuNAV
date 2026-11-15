import { useEffect, useRef, useState, type ReactNode } from "react";
import { BestPlanFinder } from "../components/BestPlanFinder";
import { Drawer } from "../components/Drawer";
import { MissionSidebar } from "../components/MissionSidebar";
import { MoonMap, type SiteTone } from "../components/MoonMap";
import { lookup } from "../lib/constraints";
import { timelineOf, PLAY_PHASES } from "../lib/mission";
import { planVerdict } from "../lib/siteBrief";
import { STRINGS } from "../lib/strings";
import { sceneBridge } from "../scene3d/bridge";
import { SceneHost } from "../scene3d/SceneHost";
import { appStore, useApp } from "../store/appStore";
import { CompareView } from "./CompareView";
import { MissionStage } from "./MissionStage";
import { SiteBrief } from "./SiteBrief";

/** The scene is only mounted for the journey; planning happens on the 2D Moon map. */
const isPlanning = () => appStore.getState().viewMode !== "live";

/**
 * Mission Planner (decision A7; planner redesign REDIS + 3C). Planning: the sidebar (arrival date, stay, site)
 * beside a 2D Moon map of the south pole with the landing sites, and the chosen site told in plain words.
 * "Launch" plays the whole journey in the one 3D scene; "Land at …" opens the same scene directly at the site.
 * Search and comparison (calendar, constraints, tray, site) open in a panel over the stage.
 */
export function PlannerView({ tools }: { tools: ReactNode }) {
  const planId = useApp((s) => s.selectedPlanId);
  const plan = useApp((s) => (s.selectedPlanId ? s.plansById.get(s.selectedPlanId) : undefined));
  const sites = useApp((s) => s.sites);
  const index = useApp((s) => (plan ? s.windowIndex[plan.window_days] : undefined));
  const viewMode = useApp((s) => s.viewMode);
  const missionPhase = useApp((s) => s.missionPhase);
  const drawerOpen = useApp((s) => s.drawerOpen);
  const pinned = useApp((s) => s.comparePlans.length);
  const setDrawerOpen = useApp((s) => s.setDrawerOpen);
  const finderOpen = useApp((s) => s.finderOpen);
  const setFinderOpen = useApp((s) => s.setFinderOpen);
  const selectSite = useApp((s) => s.selectSite);
  const [launched, setLaunched] = useState(false);
  const mission = viewMode === "live";

  // during the journey the scene follows a change of plan from the thumbnails (switchLivePlan handles the
  // clock); a plan chosen while planning is loaded when the scene mounts
  const shown = useRef(planId);
  useEffect(() => {
    if (!planId || planId === shown.current) return;
    if (mission) {
      shown.current = planId;
      return;
    }
    let alive = true;
    const st = appStore.getState();
    const p = st.plansById.get(planId);
    if (!p || !sceneBridge.setPlan) return;
    void st.data.trajectory(p.trajectory_id).then((traj) => {
      if (!alive || !sceneBridge.setPlan) return;
      sceneBridge.setPlan({ trajectory: traj, timeline: timelineOf(p, traj), siteId: p.site_id });
      shown.current = planId;
    });
    return () => {
      alive = false;
    };
  }, [planId, mission]);

  const launch = () => {
    setDrawerOpen(false);
    setLaunched(true);
    appStore.getState().setMissionPhase("overview"); // the controls start the mission at the countdown
    appStore.getState().setViewMode("live");
  };

  // straight to the site (REDIS screen 3): the scene opens at the landing, paused, with the stay ahead
  const land = () => {
    const st = appStore.getState();
    const p = st.selectedPlanId ? st.plansById.get(st.selectedPlanId) : undefined;
    if (!p) return;
    setDrawerOpen(false);
    setLaunched(false);
    st.setMissionPhase("site");
    st.setMissionTime(Date.parse(p.arrival_utc));
    st.setViewMode("live");
  };

  const tone = (siteId: string): SiteTone => {
    const m = index && plan ? lookup(index, siteId, plan.arrival_utc.slice(0, 10)) : null;
    return m ? planVerdict(m) : undefined; // B2: the same verdict as the sidebar list
  };

  const current = mission ? (missionPhase === "overview" ? "launch" : missionPhase) : "plan";
  return (
    <div className="planner" data-stage={mission ? "mission" : "planning"} data-testid="planner">
      {planId && mission && (
        <div className="planner-scene">
          <SceneHost planning={isPlanning} />
        </div>
      )}
      <header className="planner-top">
        <div className="landing-tools">
          {/* search and comparison stay one click away during the journey too (TR.2.c) */}
          {mission && (
            <button type="button" className="btn ghost" onClick={() => setDrawerOpen(true)}>
              {STRINGS.planner.search(pinned)}
            </button>
          )}
          {tools}
        </div>
      </header>
      {!mission && <MissionSidebar onLaunch={launch} onOpenSearch={() => setDrawerOpen(true)} onOpenFinder={() => setFinderOpen(true)} />}
      {!mission && plan && (
        <div className="plan-stage">
          <MoonMap sites={sites} selectedId={plan.site_id} tone={tone} onSelect={(id) => selectSite(id)} />
          <SiteBrief onLand={land} />
        </div>
      )}
      {mission && <MissionStage autoPlay={launched} />}
      {/* B5: no ILLUSTRATIVE label while planning (no trajectory is drawn); the journey keeps its own (MissionStage) */}
      <ol className="phase-rail" aria-label={STRINGS.planner.phaseRail}>
        {(["plan", ...PLAY_PHASES] as const).map((p) => (
          <li key={p} aria-current={p === current ? "step" : undefined}>
            {STRINGS.planner.phases[p]}
          </li>
        ))}
      </ol>
      {drawerOpen && (
        <Drawer title={STRINGS.planner.searchTitle} closeLabel={STRINGS.planner.closeSearch} onClose={() => setDrawerOpen(false)} testId="search-drawer">
          <CompareView />
        </Drawer>
      )}
      {finderOpen && !mission && (
        <Drawer title={STRINGS.finder.title} closeLabel={STRINGS.finder.close} onClose={() => setFinderOpen(false)} testId="finder-drawer">
          <BestPlanFinder onSelected={() => setFinderOpen(false)} />
        </Drawer>
      )}
    </div>
  );
}
