import type { Timeseries } from "../lib/contract";
import { fmtDuration, fmtUtc, type Change } from "../lib/moonMap";
import type { PlanData } from "../lib/planData";
import { overlapH, readAt, stayChange, upcoming, visibleSpans, type Span, type StayChange } from "../lib/siteBrief";
import { STRINGS } from "../lib/strings";
import { num } from "../lib/why";

const DAY_MS = 86_400_000;

/**
 * Time left at the site (planner redesign, REDIS screen 3 in 3C style): how long the Sun and the Earth stay above
 * the terrain from the mission clock, when they go, and what follows, with a thin line over the stay. Read from the
 * site's one-year series, so a countdown can run past the end of the stay.
 */
export function TimeLeft({ plan, ts, timeMs, limitH }: { plan: PlanData; ts: Timeseries; timeMs: number; limitH: number | null }) {
  const startMs = plan.series.startMs;
  const stayMs = plan.plan.window_days * DAY_MS;
  const endMs = startMs + stayMs;
  const r = readAt(ts, timeMs);
  const now = Math.min(1, Math.max(0, (timeMs - startMs) / stayMs));
  const sunSpans = visibleSpans(plan.series.sunVis, 0, plan.series.n);
  const earthSpans = visibleSpans(plan.series.earthVis, 0, plan.series.n);
  // B4: a change after the end of the stay is not counted down ("All stay"); its date stays as a side note
  const sun = r.sun ? stayChange(r.sun, timeMs, endMs) : null;
  const earth = r.earth ? stayChange(r.earth, timeMs, endMs) : null;
  const whole = timeMs <= startMs ? STRINGS.siteLayout.allStay : STRINGS.siteLayout.restOfStay;

  const sunNote = (c: Change, s: StayChange): string => {
    if (!s.withinStay) return ""; // the value already says it lasts the stay
    if (!c.visible) return STRINGS.siteLayout.sunBackInStay;
    const t = s.atMs as number;
    if (c.lastsH === null) return STRINGS.siteLayout.nightThen(STRINGS.siteLayout.noData, null, null);
    // B3: a night that runs past the end of the stay says how much of it falls inside, the figure the list shows;
    // the user's limit applies to that same part (it is the window metric longest_dark_h)
    const inStayH = overlapH(t, t + c.lastsH * 3_600_000, startMs, endMs);
    const over = limitH !== null && inStayH > limitH ? `${num(inStayH - limitH)} h` : null;
    return STRINGS.siteLayout.nightThen(`${num(c.lastsH)} h`, inStayH < c.lastsH ? `${num(inStayH)} h` : null, over);
  };
  const earthNote = (c: Change, s: StayChange): string =>
    s.withinStay && c.visible ? STRINGS.siteLayout.gapThen(c.lastsH === null ? STRINGS.siteLayout.noData : `${num(c.lastsH)} h`) : "";

  return (
    <div className="time-left" data-testid="time-left">
      {/* B10: the day of the stay is the mission clock's (MissionControls), not repeated here */}
      <p className="site-card-label">{STRINGS.siteLayout.timeLeft}</p>
      {r.sun && sun && (
        <Countdown
          body="sun"
          label={r.sun.visible ? STRINGS.siteLayout.sunLeft : sun.withinStay ? STRINGS.siteLayout.sunBack : STRINGS.siteLayout.sunDown}
          stay={sun}
          whole={whole}
          whenText={(w) => (r.sun?.visible ? STRINGS.siteLayout.sunsetAt(w) : STRINGS.siteLayout.sunriseAt(w))}
          note={sunNote(r.sun, sun)}
          warn={r.sun.visible && sun.withinStay}
          spans={sunSpans}
          now={now}
        />
      )}
      {r.earth && earth && (
        <Countdown
          body="earth"
          label={r.earth.visible ? STRINGS.siteLayout.earthLeft : earth.withinStay ? STRINGS.siteLayout.earthBack : STRINGS.siteLayout.earthDown}
          stay={earth}
          whole={whole}
          whenText={(w) => (r.earth?.visible ? STRINGS.siteLayout.earthsetAt(w) : STRINGS.siteLayout.earthriseAt(w))}
          note={earthNote(r.earth, earth)}
          warn={r.earth.visible && earth.withinStay}
          spans={earthSpans}
          now={now}
        />
      )}
    </div>
  );
}

function Countdown(p: {
  body: "sun" | "earth";
  label: string;
  stay: StayChange;
  /** "All stay" or "Rest of stay": the value when the change is after the stay */
  whole: string;
  whenText(w: string): string;
  note: string;
  warn: boolean;
  spans: Span[];
  now: number;
}) {
  const { withinStay, hours, atMs } = p.stay;
  return (
    <div className="countdown" data-body={p.body} data-testid={`countdown-${p.body}`} data-within-stay={withinStay}>
      <span className="countdown-label">{p.label}</span>
      <span className="countdown-value">{withinStay && hours !== null ? fmtDuration(hours) : p.whole}</span>
      {atMs !== null && (
        <span className="countdown-when">
          {p.whenText(fmtUtc(atMs))}
          {!withinStay && ` · ${STRINGS.siteLayout.afterYouLeave}`}
        </span>
      )}
      <span className="countdown-line" aria-hidden="true">
        {p.spans.map((s) => (
          <span key={s.from} className="on" style={{ left: `${s.from * 100}%`, width: `${(s.to - s.from) * 100}%` }} />
        ))}
        <span className="past" style={{ width: `${p.now * 100}%` }} />
        <span className="now" style={{ left: `${p.now * 100}%` }} />
      </span>
      {p.note && (
        <span className="countdown-note" data-warn={p.warn || undefined}>
          {p.note}
        </span>
      )}
    </div>
  );
}

/** What happens next from the mission clock: the Sun's next changes, the Earth's, and the end of the stay. */
export function NextEvents({ ts, timeMs, endMs }: { ts: Timeseries; timeMs: number; endMs: number }) {
  const events = upcoming(ts, timeMs, endMs);
  if (events.length === 0) return <p className="muted-note">{STRINGS.siteLayout.nothingNext}</p>;
  return (
    <ol className="next-events" data-testid="next-events">
      {events.map((e) => {
        const qual = e.kind === "end" ? (e.inDark ? STRINGS.siteLayout.inDark : "") : e.afterStay ? STRINGS.siteLayout.afterStay : "";
        return (
          <li key={`${e.kind}-${e.atMs}`} data-kind={e.kind} data-after={e.afterStay || undefined}>
            <span className="next-in">{fmtDuration((e.atMs - timeMs) / 3_600_000)}</span>
            <span className="next-what">
              {STRINGS.siteLayout.events[e.kind]}
              {qual && <span className="muted">, {qual}</span>}
            </span>
            <span className="next-when">{fmtUtc(e.atMs).replace(" UTC", "")}</span>
          </li>
        );
      })}
    </ol>
  );
}
