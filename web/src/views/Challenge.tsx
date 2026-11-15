import { useMemo, useState } from "react";
import { ErrorMessage } from "../components/ErrorMessage";
import { evaluate, LEVEL_1, monthDays, monthOutcomes, type ChallengeResult } from "../lib/challenge";
import { ASSUMED_BATTERY } from "../lib/energy";
import { describeError } from "../lib/errors";
import { fmtDay } from "../lib/format";
import { sliceWindow } from "../lib/planData";
import { STRINGS } from "../lib/strings";
import { num } from "../lib/why";
import { TimeRibbon } from "../panels2d/TimeRibbon";
import { useApp } from "../store/appStore";
import "../styles/challenge.css";
import { useTimeseries } from "./useTimeseries";

const T = STRINGS.challenge;

interface Attempt {
  siteId: string;
  day: string;
  result: ChallengeResult;
}

/** "March 2027" for a level's "2027-03". */
const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/**
 * "Can your lander make it?" (C3, level 1): a mission fixes the month and the stay; the player picks a landing site
 * and an arrival day and launches. The result says at once whether the ASSUMED lander kept its power, and why, from
 * the site's real series (lib/challenge.ts). After each attempt the days of that site that work are revealed, so the
 * player learns that the site and the day both matter. 2D only: no WebGL.
 */
export function Challenge({ onWatch, onClose }: { onWatch(siteId: string, day: string): void; onClose(): void }) {
  const sites = useApp((s) => s.sites);
  const level = LEVEL_1;
  const days = useMemo(() => monthDays(level), [level]);
  const month = monthName(level.month);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [tries, setTries] = useState(0);
  const [revealed, setRevealed] = useState<Record<string, Record<string, boolean>>>({});
  const { ts, error, retry } = useTimeseries(siteId ?? undefined);
  const site = sites.find((s) => s.id === siteId);
  const marks = siteId ? revealed[siteId] : undefined;

  const pickSite = (id: string) => {
    setSiteId(id);
    setAttempt(null);
  };
  const pickDay = (d: string) => {
    setDay(d);
    setAttempt(null);
  };
  const launch = () => {
    if (!ts || !siteId || !day) return;
    const result = evaluate(ts, day, level.stayDays);
    if (!result) return;
    setAttempt({ siteId, day, result });
    setTries((n) => n + 1);
    setRevealed((r) => ({ ...r, [siteId]: monthOutcomes(ts, level) }));
  };
  const series = useMemo(
    () => (attempt && ts && attempt.siteId === siteId ? sliceWindow(ts, `${attempt.day}T00:00:00Z`, level.stayDays) : null),
    [attempt, ts, siteId, level.stayDays],
  );

  return (
    <section className="challenge" aria-labelledby="challenge-title" data-testid="challenge">
      <div className="challenge-panel glass">
        <header className="challenge-head">
          <div>
            <p className="edu-kicker">{T.kicker(level.id)}</p>
            <h2 id="challenge-title" className="challenge-title">
              {T.title}
            </h2>
          </div>
          <button type="button" className="btn ghost pill" onClick={onClose}>
            {T.back}
          </button>
        </header>

        <div className="challenge-brief">
          <p className="challenge-mission">{T.mission(level.stayDays, month)}</p>
          <p className="challenge-lander" title={T.assumedTitle}>
            <span className="badge assumed">ASSUMED</span>{" "}
            {T.lander(ASSUMED_BATTERY.capacityWh / 1000, ASSUMED_BATTERY.loadW, ASSUMED_BATTERY.solarW, num(ASSUMED_BATTERY.capacityWh / ASSUMED_BATTERY.loadW))}
          </p>
        </div>

        <div className="challenge-step">
          <h3 className="challenge-step-title">{T.siteStep}</h3>
          <div className="challenge-sites" role="group" aria-label={T.siteStep}>
            {sites.map((s) => (
              <button key={s.id} type="button" aria-pressed={s.id === siteId} onClick={() => pickSite(s.id)}>
                {s.name}
              </button>
            ))}
          </div>
        </div>

        <div className="challenge-step">
          <h3 className="challenge-step-title">{T.dayStep(month)}</h3>
          <div className="challenge-days" role="group" aria-label={T.dayStep(month)}>
            {days.map((d) => {
              const outcome = marks?.[d];
              return (
                <button
                  key={d}
                  type="button"
                  className="challenge-day"
                  aria-pressed={d === day}
                  aria-label={T.dayLabel(fmtDay(d), outcome)}
                  data-outcome={outcome === undefined ? undefined : outcome ? "ok" : "lost"}
                  onClick={() => pickDay(d)}
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
          {marks && site && <p className="challenge-hint">{T.revealHint(site.name)}</p>}
        </div>

        {error !== null && <ErrorMessage what={STRINGS.errors.site} info={describeError(error)} onRetry={retry} />}

        {!attempt && (
          <div className="challenge-actions">
            <button type="button" className="btn primary pill" disabled={!siteId || !day || !ts} onClick={launch}>
              {T.launch}
            </button>
            <span className="challenge-hint">{!siteId || !day ? T.pickFirst : !ts ? T.loading : ""}</span>
          </div>
        )}

        {attempt && site && (
          <div className="challenge-result" data-success={attempt.result.success} data-testid="challenge-result" aria-live="polite">
            <p className="challenge-attempt">{T.attempt(tries, site.name, fmtDay(attempt.day))}</p>
            <h3 className="challenge-verdict">
              <span aria-hidden="true">{attempt.result.success ? "✓ " : "✗ "}</span>
              {attempt.result.success ? T.success : T.failure}
            </h3>
            <p className="challenge-why" data-testid="challenge-why">
              {explain(attempt.result, site.name, level.stayDays)}
            </p>
            <p className="challenge-sun">{T.sunlight(num(attempt.result.sunPct))}</p>
            {series && <TimeRibbon series={series} compareTime={0} thin />}
            <p className="challenge-lesson">{T.lesson}</p>
            <div className="challenge-actions">
              <button type="button" className={`btn pill${attempt.result.success ? "" : " primary"}`} onClick={() => setAttempt(null)}>
                {T.tryAgain}
              </button>
              {attempt.result.success && (
                <button type="button" className="btn primary pill" onClick={() => onWatch(attempt.siteId, attempt.day)}>
                  {T.watch}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
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
