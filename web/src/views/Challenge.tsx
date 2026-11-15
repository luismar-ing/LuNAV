import { useEffect, useMemo, useState, type ReactNode } from "react";
import { LEVEL_1, monthDays } from "../lib/challenge";
import { ASSUMED_BATTERY } from "../lib/energy";
import { fmtDay } from "../lib/format";
import { STRINGS } from "../lib/strings";
import { num } from "../lib/why";
import { SceneHost } from "../scene3d/SceneHost";
import { appStore, useApp } from "../store/appStore";
import "../styles/challenge.css";
import { useScenePlan } from "./useScenePlan";

const T = STRINGS.challenge;

/** Read by the scene every frame: while the player chooses, the globe shows the launch pad (planning view). */
const stageNow = { planning: true };
const isPlanning = () => stageNow.planning;

/** "March 2027" for a level's "2027-03". */
const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/**
 * "Can your lander make it?" (C3), opened from the Educator's last chapter: its own screen over the one 3D scene.
 * The mission fixes the month and the stay; in the sidebar the player picks a landing site and an arrival day, and
 * the globe follows that plan (Earth with the launch pad, the Moon and the Sun from SPICE).
 */
export function Challenge({ tools }: { tools: ReactNode }) {
  const sites = useApp((s) => s.sites);
  const plan = useApp((s) => (s.selectedPlanId ? s.plansById.get(s.selectedPlanId) : undefined));
  const level = LEVEL_1;
  const days = useMemo(() => monthDays(level), [level]);
  const month = monthName(level.month);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const timeline = useScenePlan(plan);

  // the chosen site and day are the mission's plan (the 7-day plan of that site and arrival day)
  useEffect(() => {
    if (!siteId || !day) return;
    const id = `${siteId}_${day.replace(/-/g, "")}_${level.stayDays}d`;
    if (appStore.getState().plansById.has(id)) appStore.getState().selectPlan(id);
  }, [siteId, day, level.stayDays]);

  // while choosing, the clock waits at the start of the countdown
  useEffect(() => {
    if (!timeline) return;
    stageNow.planning = true;
    appStore.getState().setMissionTime(timeline.startMs);
    appStore.getState().setMissionPhase("overview");
  }, [timeline]);
  useEffect(() => () => void (stageNow.planning = true), []);

  // Esc leaves for the start page, as in the Educator
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) appStore.getState().setScreen("landing");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="challenge-screen" data-testid="challenge">
      {plan && (
        <div className="planner-scene">
          <SceneHost planning={isPlanning} />
        </div>
      )}
      <header className="planner-top">
        <div className="landing-tools">{tools}</div>
      </header>

      <aside className="mission-sidebar glass challenge-sidebar" aria-labelledby="challenge-title">
        <div>
          <p className="edu-kicker">{T.kicker(level.id)}</p>
          <h2 id="challenge-title" className="challenge-title">
            {T.title}
          </h2>
        </div>
        <p className="challenge-mission">{T.mission(level.stayDays, month)}</p>
        <p className="challenge-lander" title={T.assumedTitle}>
          <span className="badge assumed">ASSUMED</span>{" "}
          {T.lander(ASSUMED_BATTERY.capacityWh / 1000, ASSUMED_BATTERY.loadW, ASSUMED_BATTERY.solarW, num(ASSUMED_BATTERY.capacityWh / ASSUMED_BATTERY.loadW))}
        </p>

        <section className="sidebar-block" aria-labelledby="challenge-site">
          <h3 id="challenge-site" className="sidebar-label">
            {T.siteStep}
          </h3>
          <div className="challenge-sites" role="group" aria-labelledby="challenge-site">
            {sites.map((s) => (
              <button key={s.id} type="button" aria-pressed={s.id === siteId} onClick={() => setSiteId(s.id)}>
                {s.name}
              </button>
            ))}
          </div>
        </section>

        <section className="sidebar-block" aria-labelledby="challenge-day">
          <h3 id="challenge-day" className="sidebar-label">
            {T.dayStep(month)}
          </h3>
          <div className="challenge-days" role="group" aria-labelledby="challenge-day">
            {days.map((d) => (
              <button key={d} type="button" className="challenge-day" aria-pressed={d === day} aria-label={fmtDay(d)} onClick={() => setDay(d)}>
                <span className="challenge-day-n">{Number(d.slice(8))}</span>
              </button>
            ))}
          </div>
        </section>

        <div className="challenge-actions">
          <button type="button" className="btn ghost pill" onClick={() => appStore.getState().setScreen("educator")}>
            {T.back}
          </button>
        </div>
      </aside>
    </div>
  );
}
