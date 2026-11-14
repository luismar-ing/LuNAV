import { useMemo } from "react";
import { ErrorMessage } from "../components/ErrorMessage";
import { lookup } from "../lib/constraints";
import { parseInstant } from "../lib/contract";
import { describeError } from "../lib/errors";
import { distanceKm, fmtDuration, type Change } from "../lib/moonMap";
import { readAt, story, visibleSpans, type Span } from "../lib/siteBrief";
import { STRINGS } from "../lib/strings";
import { fmtMetric, num, round } from "../lib/why";
import { useApp } from "../store/appStore";
import { useTimeseries } from "./useTimeseries";

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * The chosen site, told in plain words (planner redesign, 3C style): where it is, one sentence on what the stay
 * looks like, thin Sun and Earth tracks with their countdowns, three window metrics, the same day at the other
 * sites, and the way on: "Land at …" opens the site view, "Pin to compare" adds the plan to the comparison.
 */
export function SiteBrief({ onLand }: { onLand(): void }) {
  const plan = useApp((s) => (s.selectedPlanId ? s.plansById.get(s.selectedPlanId) : undefined));
  const sites = useApp((s) => s.sites);
  const index = useApp((s) => (plan ? s.windowIndex[plan.window_days] : undefined));
  const limit = useApp((s) => s.constraints.maxDarkH);
  const pinned = useApp((s) => (plan ? s.comparePlans.includes(plan.id) : false));
  const pinPlan = useApp((s) => s.pinPlan);
  const unpinPlan = useApp((s) => s.unpinPlan);
  const { ts, error, retry } = useTimeseries(plan?.site_id);
  const site = sites.find((s) => s.id === plan?.site_id);

  const arrivalMs = plan ? parseInstant(plan.arrival_utc) : 0;
  const stayH = plan ? plan.window_days * 24 : 0;
  const reading = useMemo(() => (ts && plan ? readAt(ts, arrivalMs) : null), [ts, plan, arrivalMs]);
  const spans = useMemo(() => {
    if (!ts || !reading || !plan) return null;
    const n = Math.round((stayH * 60) / ts.step_min);
    return { sun: visibleSpans(ts.sun_vis, reading.k, n), earth: visibleSpans(ts.earth_vis, reading.k, n) };
  }, [ts, reading, plan, stayH]);

  if (!plan || !site) return null;
  const day = plan.arrival_utc.slice(0, 10);
  const m = index ? lookup(index, site.id, day) : null;
  const others = sites
    .filter((s) => s.id !== site.id)
    .map((s) => ({ s, km: distanceKm(site, s), m: index ? lookup(index, s.id, day) : null }))
    .sort((a, b) => a.km - b.km);

  return (
    <section className="site-brief" aria-labelledby="brief-title" data-testid="site-brief">
      <div>
        <p className="brief-where">{STRINGS.planner.where(site.lat, site.lon, site.elevation_m)}</p>
        <h2 id="brief-title" className="brief-name">
          {site.name}
        </h2>
      </div>

      {error !== null && <ErrorMessage what={STRINGS.errors.site} info={describeError(error)} onRetry={retry} />}
      {error === null && !reading && <p className="brief-story muted">{STRINGS.loading}</p>}
      {reading && m && (
        <p className="brief-story" role="status" data-testid="brief-story">
          {story(reading, stayH, m.longest_dark_h, limit)}
        </p>
      )}

      {reading && spans && (
        <div className="brief-tracks" role="group" aria-label={STRINGS.planner.tracksAria(site.name)}>
          <Track label={STRINGS.planner.sunTrack} spans={spans.sun} body="sun" change={reading.sun} />
          <Track label={STRINGS.planner.earthTrack} spans={spans.earth} body="earth" change={reading.earth} />
          <div className="brief-track-axis" aria-hidden="true">
            <span />
            <span className="brief-track-ends">
              <span>{STRINGS.planner.landing(fmtDate(arrivalMs))}</span>
              <span>{STRINGS.planner.lastDay(plan.window_days)}</span>
            </span>
            <span />
          </div>
        </div>
      )}

      {m && (
        <dl className="brief-metrics">
          <div>
            <dt>{STRINGS.planner.sunlight}</dt>
            <dd>{fmtMetric("sun_pct", m.sun_pct)} %</dd>
          </div>
          <div>
            <dt>{STRINGS.planner.longestNight}</dt>
            <dd data-tone={m.longest_dark_h > 0 ? "night" : "lit"}>{num(m.longest_dark_h)} h</dd>
          </div>
          <div>
            <dt>{STRINGS.planner.earthWorst}</dt>
            <dd>{num(m.earth_h_min)} h</dd>
          </div>
        </dl>
      )}

      <div className="brief-others">
        <h3 className="brief-label">{STRINGS.planner.others}</h3>
        <ul data-testid="brief-others">
          {others.map(({ s, km, m: o }) => {
            const d = o && m ? Number(round(o.sun_pct - m.sun_pct, 1)) : null;
            return (
              <li key={s.id}>
                <span>{s.name}</span>
                <span className="muted">{Math.round(km)} km</span>
                <span data-trend={d === null ? undefined : d > 0 ? "up" : d < 0 ? "down" : "same"}>
                  {d === null ? "" : d === 0 ? STRINGS.planner.sameLight : STRINGS.planner.deltaSun(`${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}`)}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="brief-actions">
        <button type="button" className="btn primary pill" onClick={onLand}>
          {STRINGS.planner.land(site.name)}
        </button>
        <button type="button" className="btn ghost pill" aria-pressed={pinned} onClick={() => (pinned ? unpinPlan(plan.id) : pinPlan(plan.id))}>
          {pinned ? STRINGS.planner.unpinPlan : STRINGS.planner.pinPlan}
        </button>
      </div>
    </section>
  );
}

/** One body's thin track over the stay (3 px), with its countdown to the next change. */
function Track({ label, spans, body, change }: { label: string; spans: Span[]; body: "sun" | "earth"; change: Change | null }) {
  const when = change?.hours == null ? STRINGS.planner.noChange : fmtDuration(change.hours);
  return (
    <div className="brief-track" data-body={body}>
      <span className="brief-track-label">{label}</span>
      <span className="brief-track-line">
        {spans.map((s) => (
          <span key={s.from} style={{ left: `${s.from * 100}%`, width: `${(s.to - s.from) * 100}%` }} />
        ))}
      </span>
      <span className="brief-track-count">
        <span className="brief-track-verb">{change?.visible ? STRINGS.planner.setsIn : STRINGS.planner.risesIn}</span> {when}
      </span>
    </div>
  );
}
