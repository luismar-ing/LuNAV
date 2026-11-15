import { useEffect, useMemo, useState, type ReactNode } from "react";
import { evaluate, LEVEL_1, monthDays, stayTrace, traceAt, type ChallengeResult, type StayTrace } from "../lib/challenge";
import { ASSUMED_BATTERY } from "../lib/energy";
import { fmtDay, fmtUtc } from "../lib/format";
import { sliceWindow } from "../lib/planData";
import { phaseAt } from "../lib/mission";
import { stayDay, visibleSpans } from "../lib/siteBrief";
import { STRINGS } from "../lib/strings";
import { num } from "../lib/why";
import { TimeRibbon } from "../panels2d/TimeRibbon";
import { SceneHost } from "../scene3d/SceneHost";
import type { Timeseries } from "../lib/contract";
import { appStore, useApp } from "../store/appStore";
import "../styles/challenge.css";
import { useMissionPlayback } from "./useMissionPlayback";
import { useScenePlan } from "./useScenePlan";
import { useTimeseries } from "./useTimeseries";

const T = STRINGS.challenge;
/**
 * Mission hours per second of playback, until the player picks a speed: the trip to the Moon (about 10 s), the
 * descent from lunar arrival to touchdown (slow, as in the Educator's landing chapter, so the arrival at the Moon
 * can be seen) and the stay (7 days in about a minute, so a night that drains the battery can be followed).
 */
const FLIGHT_HPS = 6;
const LANDING_HPS = 1;
const STAY_HPS = 3;
/** Speeds the player can choose (hours of mission per second), as in the Mission Planner's controls. */
const SPEEDS = [1, 3, 6, 24] as const;

/** Read by the scene every frame: while the player chooses, the globe shows the launch pad (planning view). */
const stageNow = { planning: true };
const isPlanning = () => stageNow.planning;

/** "March 2027" for a level's "2027-03". */
const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** Choosing, flying (launch to landing), the stay at the site, and the end (stay over or power lost). */
type Stage = "pick" | "flight" | "stay" | "done";

/** A stretch of the mission played in one go: up to `to` (epoch ms) at `hps` hours per second by default. */
interface Segment {
  to: number;
  hps: number;
}
/** The mission's stretches: trip, descent and stay; the stage follows the one under way. */
const stageOf = (seg: number): Stage => (seg < 0 ? "pick" : seg < 2 ? "flight" : seg === 2 ? "stay" : "done");

interface Run {
  siteId: string;
  day: string;
  result: ChallengeResult;
  trace: StayTrace;
}

/**
 * "Can your lander make it?" (C3), opened from the Educator's last chapter: its own screen over the one 3D scene.
 * The mission fixes the month and the stay; in the sidebar the player picks a landing site and an arrival day, and
 * the globe follows that plan (Earth with the launch pad, the Moon and the Sun from SPICE). "Launch" flies the
 * mission in the scene and plays the stay at the site with the ASSUMED battery, which stops the mission where the
 * battery runs empty: the cause is the site's real night, never the (ILLUSTRATIVE) flight.
 */
export function Challenge({ tools }: { tools: ReactNode }) {
  const sites = useApp((s) => s.sites);
  const plan = useApp((s) => (s.selectedPlanId ? s.plansById.get(s.selectedPlanId) : undefined));
  const level = LEVEL_1;
  const days = useMemo(() => monthDays(level), [level]);
  const month = monthName(level.month);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [seg, setSeg] = useState(-1); // stretch under way (-1: choosing; 3: over)
  const stage = stageOf(seg);
  const [speed, setSpeed] = useState<number | null>(null); // the player's speed, once chosen
  const [paused, setPaused] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  // the player's own attempts, site by site (only the days tried are marked: the answers are never revealed)
  const [tried, setTried] = useState<Record<string, Record<string, boolean>>>({});
  const [attempts, setAttempts] = useState(0);
  const timeline = useScenePlan(plan);
  const { ts } = useTimeseries(siteId ?? undefined);
  const { play, setPlay } = useMissionPlayback(timeline);
  const segments = useMemo<Segment[]>(
    () =>
      run && timeline
        ? [
            { to: timeline.lunarArrivalMs, hps: FLIGHT_HPS },
            { to: timeline.landingMs, hps: LANDING_HPS },
            { to: run.trace.powerLostMs ?? timeline.endMs, hps: STAY_HPS }, // the stay stops where the power runs out
          ]
        : [],
    [run, timeline],
  );

  // the chosen site and day are the mission's plan (the 7-day plan of that site and arrival day)
  const planId = siteId && day ? `${siteId}_${day.replace(/-/g, "")}_${level.stayDays}d` : null;
  useEffect(() => {
    if (planId && appStore.getState().plansById.has(planId)) appStore.getState().selectPlan(planId);
  }, [planId]);
  // ready to launch once the scene's timeline is the chosen plan's
  const ready = !!(ts && timeline && plan && plan.id === planId && timeline.landingMs === Date.parse(plan.arrival_utc));

  // while choosing, the clock waits at the start of the countdown
  useEffect(() => {
    if (!timeline || stage !== "pick") return;
    stageNow.planning = true;
    appStore.getState().setMissionTime(timeline.startMs);
    appStore.getState().setMissionPhase("overview");
  }, [timeline, stage]);
  useEffect(() => () => void (stageNow.planning = true), []);

  const fly = () => {
    if (!timeline) return;
    stageNow.planning = false; // the camera leaves the globe view for the mission
    appStore.getState().setMissionTime(timeline.startMs);
    appStore.getState().setMissionPhase("launch");
    setPaused(false);
    setSeg(0);
  };
  const launch = () => {
    if (!ready || !ts || !siteId || !day) return;
    const result = evaluate(ts, day, level.stayDays);
    const trace = stayTrace(ts, day, level.stayDays);
    if (!result || !trace) return;
    setRun({ siteId, day, result, trace });
    setAttempts((n) => n + 1);
    fly();
  };
  const tryAgain = () => {
    setSeg(-1); // the clock goes back to the countdown and the camera to the globe (effect above)
    setRun(null);
  };

  // each stretch plays at its own speed, or the player's, unless paused
  useEffect(() => {
    const cur = segments[seg];
    if (cur) setPlay(paused ? null : { to: cur.to, hoursPerSecond: speed ?? cur.hps });
  }, [seg, segments, speed, paused, setPlay]);
  // a stretch that reaches its end runs into the next one: trip, descent, stay, end
  useEffect(() => {
    const cur = segments[seg];
    if (play || paused || !cur) return;
    if ((appStore.getState().missionTime ?? 0) >= cur.to) setSeg(seg + 1);
  }, [play, paused, seg, segments]);
  const skip = () => {
    const cur = segments[seg];
    if (!cur || !timeline) return;
    appStore.getState().setMissionTime(cur.to);
    appStore.getState().setMissionPhase(phaseAt(timeline, cur.to));
    setSeg(seg + 1);
  };
  // the day just tried is marked on the calendar (only the player's own attempts)
  useEffect(() => {
    if (seg === 3 && run) setTried((t) => ({ ...t, [run.siteId]: { ...t[run.siteId], [run.day]: run.result.success } }));
  }, [seg, run]);

  // Esc leaves for the start page, as in the Educator
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) appStore.getState().setScreen("landing");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const site = sites.find((s) => s.id === (run?.siteId ?? siteId));

  return (
    <div className="challenge-screen" data-testid="challenge" data-stage={stage}>
      {plan && (
        <div className="planner-scene">
          <SceneHost planning={isPlanning} />
        </div>
      )}
      <header className="planner-top">
        <div className="landing-tools">{tools}</div>
      </header>

      {stage === "pick" ? (
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
              {days.map((d) => {
                const outcome = siteId ? tried[siteId]?.[d] : undefined;
                return (
                  <button
                    key={d}
                    type="button"
                    className="challenge-day"
                    aria-pressed={d === day}
                    aria-label={T.dayLabel(fmtDay(d), outcome)}
                    data-outcome={outcome === undefined ? undefined : outcome ? "ok" : "lost"}
                    onClick={() => setDay(d)}
                  >
                    <span className="challenge-day-n">{Number(d.slice(8))}</span>
                    {outcome !== undefined && (
                      <span className="challenge-day-mark" aria-hidden="true">
                        {outcome ? "✓" : "✗"}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>

          <div className="challenge-actions challenge-launch">
            <button type="button" className="btn primary pill" disabled={!ready} onClick={launch}>
              {T.launch}
            </button>
            {!ready && <span className="challenge-hint">{!siteId || !day ? T.pickFirst : T.loading}</span>}
            <button type="button" className="btn ghost pill" onClick={() => appStore.getState().setScreen("educator")}>
              {T.back}
            </button>
          </div>
        </aside>
      ) : stage === "done" && run && ts ? (
        <ResultPanel
          run={run}
          ts={ts}
          attempt={attempts}
          siteName={site?.name ?? ""}
          stayDays={level.stayDays}
          onTryAgain={tryAgain}
          onWatchAgain={fly}
          onMenu={() => appStore.getState().setScreen("landing")}
        />
      ) : (
        run &&
        timeline && (
          <MissionHud
            siteName={site?.name ?? ""}
            day={run.day}
            trace={run.trace}
            landingMs={timeline.landingMs}
            endMs={timeline.endMs}
            speed={speed ?? segments[seg]?.hps ?? STAY_HPS}
            onSpeed={setSpeed}
            paused={paused}
            onPause={() => setPaused((p) => !p)}
            onSkip={skip}
          />
        )
      )}

      {stage === "done" && run?.trace.powerLostMs != null && (
        <div className="challenge-blackout" aria-hidden="true">
          <p>{T.powerLost(fmtUtc(run.trace.powerLostMs))}</p>
        </div>
      )}
    </div>
  );
}

/** While the mission plays: where it is, the day of the stay, the ASSUMED battery, and the Sun and the Earth. */
function MissionHud({
  siteName,
  day,
  trace,
  landingMs,
  endMs,
  speed,
  onSpeed,
  paused,
  onPause,
  onSkip,
}: {
  siteName: string;
  day: string;
  trace: StayTrace;
  landingMs: number;
  endMs: number;
  speed: number;
  onSpeed(hps: number): void;
  paused: boolean;
  onPause(): void;
  onSkip(): void;
}) {
  const t = useApp((s) => s.missionTime) ?? landingMs;
  const phase = useApp((s) => s.missionPhase);
  const at = traceAt(trace, t);
  const stay = stayDay(landingMs, endMs, t);
  const pct = Math.round(at.soc * 100);
  return (
    <aside className="mission-sidebar glass challenge-sidebar challenge-hud" aria-label={T.hud} data-testid="challenge-hud">
      <div>
        <p className="edu-kicker">{T.landingOn(fmtDay(day))}</p>
        <h2 className="challenge-title">{siteName}</h2>
      </div>
      <p className="challenge-phase">
        {STRINGS.mission.phases[phase] ?? ""}
        {stay && <span> · {T.stayDay(stay.day, stay.of)}</span>}
      </p>
      <div className="sidebar-block">
        <p className="sidebar-label">
          {T.battery} <span className="badge assumed">ASSUMED</span>
        </p>
        <div className="challenge-meter" role="meter" aria-label={T.battery} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span style={{ width: `${pct}%` }} data-empty={pct === 0 || undefined} />
        </div>
        <p className="challenge-meter-value">{pct}%</p>
        {stay && <p className="challenge-power">{at.sun ? (pct === 100 ? T.powerFull : T.powerCharging) : T.powerDraining}</p>}
      </div>
      {stay && (
        <ul className="challenge-sky">
          <li data-on={at.sun}>{at.sun ? T.sunUp : T.sunHidden}</li>
          <li data-on={at.earth}>{at.earth ? T.earthUp : T.earthHidden}</li>
        </ul>
      )}
      <StayBar trace={trace} landingMs={landingMs} endMs={endMs} t={t} />
      <div className="challenge-controls">
        <div className="segmented" role="group" aria-label={STRINGS.mission.speed}>
          {SPEEDS.map((s) => (
            <button key={s} type="button" aria-pressed={speed === s} className={speed === s ? "on" : ""} onClick={() => onSpeed(s)}>
              {STRINGS.mission.speedLabel(s)}
            </button>
          ))}
        </div>
        <div className="challenge-actions">
          <button type="button" className="btn pill" aria-pressed={paused} onClick={onPause}>
            {paused ? T.resume : T.pause}
          </button>
          <button type="button" className="btn pill" onClick={onSkip}>
            {STRINGS.educator.skip}
          </button>
        </div>
      </div>
    </aside>
  );
}

/**
 * The stay as a bar from landing to the last day (the goal): its sunlit stretches from the site's real series, the
 * days, and how far the mission has got. A mission that loses its power stops part of the way along.
 */
function StayBar({ trace, landingMs, endMs, t }: { trace: StayTrace; landingMs: number; endMs: number; t: number }) {
  const n = trace.sun.length;
  const days = Math.round((endMs - landingMs) / 86_400_000);
  const lit = useMemo(() => visibleSpans(trace.sun, 0, n), [trace, n]);
  const f = Math.min(1, Math.max(0, (t - landingMs) / (endMs - landingMs)));
  const day = stayDay(landingMs, endMs, t);
  return (
    <div className="challenge-staybar">
      <p className="sidebar-label">{T.stayBar}</p>
      <svg
        viewBox="0 0 100 10"
        preserveAspectRatio="none"
        role="img"
        aria-label={day ? T.stayBarLabel(day.day, days, Math.round(f * 100)) : T.stayStarts}
        data-progress={f.toFixed(3)}
      >
        <rect className="stay-night" x={0} y={0} width={100} height={10} />
        {lit.map((sp) => (
          <rect key={sp.from} className="stay-lit" x={sp.from * 100} y={0} width={(sp.to - sp.from) * 100} height={10} />
        ))}
        <rect className="stay-done" x={0} y={0} width={f * 100} height={10} />
        {Array.from({ length: days - 1 }, (_, i) => (
          <line key={i} className="stay-day" x1={((i + 1) * 100) / days} x2={((i + 1) * 100) / days} y1={0} y2={10} />
        ))}
        <line className="stay-now" x1={f * 100} x2={f * 100} y1={0} y2={10} />
      </svg>
      <div className="challenge-staybar-axis">
        <span>{day ? T.stayDay(day.day, days) : T.stayStarts}</span>
        <span>{T.goal(days)}</span>
      </div>
    </div>
  );
}

/** The end of the mission: the verdict and its why, from the result's own figures, the stay's time ribbon, and what next. */
function ResultPanel({
  run,
  ts,
  attempt,
  siteName,
  stayDays,
  onTryAgain,
  onWatchAgain,
  onMenu,
}: {
  run: Run;
  ts: Timeseries;
  attempt: number;
  siteName: string;
  stayDays: number;
  onTryAgain(): void;
  onWatchAgain(): void;
  onMenu(): void;
}) {
  const r = run.result;
  const series = useMemo(() => sliceWindow(ts, `${run.day}T00:00:00Z`, stayDays), [ts, run.day, stayDays]);
  return (
    <aside className="mission-sidebar glass challenge-sidebar challenge-result" aria-label={T.result} data-testid="challenge-result" data-success={r.success}>
      <p className="edu-kicker">{T.attempt(attempt, siteName, fmtDay(run.day))}</p>
      <h2 className="challenge-verdict" aria-live="polite">
        <span aria-hidden="true">{r.success ? "✓ " : "✗ "}</span>
        {r.success ? T.success : T.failure}
      </h2>
      <p className="challenge-why" data-testid="challenge-why">
        {explain(r, siteName, stayDays)}
      </p>
      <p className="challenge-sun">{T.sunlight(num(r.sunPct))}</p>
      <div className="challenge-actions challenge-result-actions">
        <button type="button" className="btn primary pill" onClick={onTryAgain}>
          {T.tryAgain}
        </button>
        <button type="button" className="btn pill" onClick={onWatchAgain}>
          {T.watchAgain}
        </button>
        <button type="button" className="btn ghost pill" onClick={onMenu}>
          {T.mainMenu}
        </button>
      </div>
      <TimeRibbon series={series} compareTime={0} thin />
      <p className="challenge-lesson">{T.lesson}</p>
    </aside>
  );
}

/** The why of a result, in one or two sentences, from the result's own figures. */
function explain(r: ChallengeResult, site: string, stayDays: number): string {
  if (r.success) {
    const first = T.successText(site, stayDays, Math.round(r.minSoc * 100));
    return r.night ? `${first} ${T.survivedNight(num(r.night.inStayH))}` : `${first} ${T.noNight}`;
  }
  const night = r.night
    ? r.night.beforeLanding
      ? T.nightInDark(num(r.night.fullH))
      : T.nightStarts(num(r.night.fullH), r.night.startDay, r.night.inStayH < r.night.fullH ? num(r.night.inStayH) : null)
    : "";
  return [T.failureText(num(r.emptyH)), night, T.batteryLasts(num(r.batteryH))].filter(Boolean).join(" ");
}
