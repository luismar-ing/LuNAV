import { useMemo } from "react";
import { ErrorMessage } from "../components/ErrorMessage";
import { VerdictMarks } from "../components/VerdictMarks";
import { lookup } from "../lib/constraints";
import { parseInstant } from "../lib/contract";
import { describeError } from "../lib/errors";
import { fmtShortDay, fmtUtc } from "../lib/format";
import { distanceKm, fmtDuration, type Change } from "../lib/moonMap";
import { nightInStay, planVerdict, readAt, stayChange, visibleSpans, type Span } from "../lib/siteBrief";
import { STRINGS } from "../lib/strings";
import { fmtMetric, num, round } from "../lib/why";
import { useApp } from "../store/appStore";
import { useTimeseries } from "./useTimeseries";


/** A site's name without its trailing note in brackets: "Connecting Ridge (Shackleton rim)" → "Connecting Ridge". */
export const shortName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, "");

/**
 * The chosen site (planner redesign, 3C style): where it is, thin Sun and Earth tracks with their countdowns, three window metrics, the same day at the other
 * sites, and the way on: "Land at …" opens the site view, "Pin to compare" adds the plan to the comparison.
 */
export function SiteBrief({ onLand }: { onLand(): void }) {
  const plan = useApp((s) => (s.selectedPlanId ? s.plansById.get(s.selectedPlanId) : undefined));
  const sites = useApp((s) => s.sites);
  const index = useApp((s) => (plan ? s.windowIndex[plan.window_days] : undefined));
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
  const night = useMemo(() => (ts && plan ? nightInStay(ts, arrivalMs, stayH) : null), [ts, plan, arrivalMs, stayH]);

  if (!plan || !site) return null;
  const day = plan.arrival_utc.slice(0, 10);
  const m = index ? lookup(index, site.id, day) : null;
  const v = m ? planVerdict(m) : null;
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
        {/* B2: one line on energy AND Earth contact, so a plan without the Earth never reads as a good one */}
        {v && (
          <p className="brief-verdict" data-tone={v.tone} data-testid="brief-verdict">
            <VerdictMarks sun={v.sun} earth={v.earth} />
            {STRINGS.planner.verdict(v.sun, v.earth, v.darkH, v.gapH)}
          </p>
        )}
      </div>

      {error !== null && <ErrorMessage what={STRINGS.errors.site} info={describeError(error)} onRetry={retry} />}
      {error === null && !reading && <p className="muted-note">{STRINGS.loading}</p>}

      {reading && spans && (
        <div className="brief-tracks" role="group" aria-label={STRINGS.planner.tracksAria(site.name)}>
          <Track label={STRINGS.planner.sunTrack} spans={spans.sun} body="sun" change={reading.sun} arrivalMs={arrivalMs} endMs={arrivalMs + stayH * 3_600_000} />
          <Track label={STRINGS.planner.earthTrack} spans={spans.earth} body="earth" change={reading.earth} arrivalMs={arrivalMs} endMs={arrivalMs + stayH * 3_600_000} />
          <div className="brief-track-axis" aria-hidden="true">
            <span />
            <span className="brief-track-ends">
              <span>{STRINGS.planner.landing(fmtShortDay(arrivalMs))}</span>
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
          <div className={night && night.fullH > night.inStayH ? "brief-metric-split" : undefined}>
            <dt>{STRINGS.planner.longestNight}</dt>
            <dd data-tone={m.longest_dark_h > 0 ? "night" : "lit"}>{num(m.longest_dark_h)} h</dd>
            {/* B3: when the night runs past the start or end of the stay, its whole length beside the part inside */}
            {night && night.fullH > night.inStayH && (
              <dd className="brief-metric-note" data-testid="brief-night-of" title={STRINGS.planner.nightOfTitle(night.inStayH, night.fullH, night.fullKnown)}>
                {STRINGS.planner.nightOf(night.fullH, night.fullKnown)}
              </dd>
            )}
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

      {/* B9 (H14): one row, fixed places. "Land at …" fills the row (short name, ellipsis if needed; the full name is
          its accessible name and title); "Pin" keeps one width whichever label it shows, so nothing moves */}
      <div className="brief-actions" data-testid="brief-actions">
        <button type="button" className="btn primary pill brief-land" aria-label={STRINGS.planner.land(site.name)} title={STRINGS.planner.land(site.name)} onClick={onLand}>
          {STRINGS.planner.land(shortName(site.name))}
        </button>
        <button type="button" className="btn ghost pill brief-pin" aria-pressed={pinned} onClick={() => (pinned ? unpinPlan(plan.id) : pinPlan(plan.id))}>
          <span>{pinned ? STRINGS.planner.unpinPlan : STRINGS.planner.pinPlan}</span>
          <span className="brief-pin-sizer" aria-hidden="true">
            {pinned ? STRINGS.planner.pinPlan : STRINGS.planner.unpinPlan}
          </span>
        </button>
      </div>
    </section>
  );
}

/** One body's thin track over the stay (3 px), with its countdown to the next change. */
function Track({ label, spans, body, change, arrivalMs, endMs }: { label: string; spans: Span[]; body: "sun" | "earth"; change: Change | null; arrivalMs: number; endMs: number }) {
  // B4: count down only to a change inside the stay; one after it reads "Up all stay" / "Down all stay", with its date aside
  const stay = change ? stayChange(change, arrivalMs, endMs) : null;
  const capped = change && stay && !stay.withinStay;
  const verb = capped ? (change.visible ? STRINGS.planner.up : STRINGS.planner.down) : change?.visible ? STRINGS.planner.setsIn : STRINGS.planner.risesIn;
  const value = capped ? STRINGS.planner.allStay : change?.hours == null ? STRINGS.planner.noChange : fmtDuration(change.hours);
  const after = capped && stay.atMs !== null ? STRINGS.planner.changeAfter(change.visible, fmtShortDay(stay.atMs)) : null;
  return (
    <div className="brief-track" data-body={body}>
      <span className="brief-track-label">{label}</span>
      <span className="brief-track-line">
        {spans.map((s) => (
          <span key={s.from} style={{ left: `${s.from * 100}%`, width: `${(s.to - s.from) * 100}%` }} />
        ))}
      </span>
      <span className="brief-track-count" data-testid={`brief-count-${body}`} title={stay?.atMs != null ? fmtUtc(stay.atMs) : undefined}>
        <span className="brief-track-verb">{verb}</span> {value}
        {after && <span className="brief-track-after"> · {after}</span>}
      </span>
    </div>
  );
}
