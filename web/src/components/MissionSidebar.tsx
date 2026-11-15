import { useEffect, useMemo, useState } from "react";
import { lookup, dayIndex } from "../lib/constraints";
import { lutIndex, rampLut } from "../lib/colorScale";
import { fmtDay } from "../lib/format";
import { lastInputWasKeyboard } from "../lib/inputModality";
import { planVerdict } from "../lib/siteBrief";
import { STRINGS } from "../lib/strings";
import { VerdictMarks } from "./VerdictMarks";
import { round } from "../lib/why";
import { useApp } from "../store/appStore";

/** Days shown in the strip around the chosen arrival day. */
export const STRIP_DAYS = 21;
const DAY_MS = 86_400_000;

// B5: the app's one date format ("Jan 11, 2027"); re-exported for the views that import it from here
export { fmtDay } from "../lib/format";
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Opens the browser's date picker where it can (showPicker needs a user gesture and is missing in older browsers). */
function openPicker(input: HTMLInputElement) {
  try {
    input.showPicker?.();
  } catch {
    /* not allowed here (e.g. inside a cross-origin frame): the input keeps working from the keyboard */
  }
}

/**
 * Mission start sidebar (decision A7, design A2): arrival date (with a strip of days coloured by the chosen
 * site's combined score, the calendar's own ramp), length of stay, landing site and "Launch". Every control
 * changes the selected plan, which the Moon map, the site brief and every other view follow.
 */
export function MissionSidebar({ onLaunch, onOpenSearch }: { onLaunch(): void; onOpenSearch(): void }) {
  const plan = useApp((s) => (s.selectedPlanId ? s.plansById.get(s.selectedPlanId) : undefined));
  const sites = useApp((s) => s.sites);
  const plansById = useApp((s) => s.plansById);
  const range = useApp((s) => s.manifest?.date_range);
  const windows = useApp((s) => s.manifest?.params.window_days ?? [3, 7, 14]);
  const pinned = useApp((s) => s.comparePlans.length);
  const index = useApp((s) => (plan ? s.windowIndex[plan.window_days] : undefined));
  const selectPlan = useApp((s) => s.selectPlan);
  const setWindow = useApp((s) => s.setWindow);
  const selectSite = useApp((s) => s.selectSite);
  const loadWindows = useApp((s) => s.loadWindows);
  const lut = useMemo(() => rampLut("combined"), []);
  const [byPointer, setByPointer] = useState(false);

  useEffect(() => {
    if (plan) void loadWindows(plan.window_days);
  }, [plan?.window_days, loadWindows]);

  if (!plan || !range) return null;
  const arrival = plan.arrival_utc.slice(0, 10);
  const first = Date.parse(range.arrival_start.slice(0, 10));
  const last = Date.parse(range.arrival_end.slice(0, 10));
  const idOf = (day: string) => `${plan.site_id}_${day.replace(/-/g, "")}_${plan.window_days}d`;
  const goDay = (ms: number) => {
    const id = idOf(ymd(Math.min(last, Math.max(first, ms))));
    if (plansById.has(id)) selectPlan(id);
  };
  // the strip: STRIP_DAYS days around the arrival, kept inside the date range
  const startMs = Math.min(Math.max(first, Date.parse(arrival) - Math.floor(STRIP_DAYS / 2) * DAY_MS), last - (STRIP_DAYS - 1) * DAY_MS);
  const days = Array.from({ length: STRIP_DAYS }, (_, i) => ymd(startMs + i * DAY_MS));
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;

  return (
    <aside className="mission-sidebar glass" aria-label={STRINGS.planner.sidebar} data-testid="mission-sidebar">
      <p className="sidebar-mode">{STRINGS.landing.planner.name}</p>

      <section className="sidebar-block" aria-labelledby="arrival-label">
        <h2 id="arrival-label" className="sidebar-label">
          {STRINGS.planner.arrival}
        </h2>
        <div className="arrival-row">
          <button type="button" className="icon-btn" aria-label={STRINGS.planner.prevDay} onClick={() => goDay(Date.parse(arrival) - DAY_MS)} disabled={Date.parse(arrival) <= first}>
            ‹
          </button>
          {/* B5 (H12): the date reads "Jan 11, 2027" like the rest of the app, not in the system's format. The native
              date input still does the work (keyboard, picker, min / max): it lies transparent over the text and the
              whole field opens its picker. */}
          {/* focus sits inside the date input's own segments, so :focus-visible never matches it: the field shows its
              ring on :focus-within unless the focus came from the pointer */}
          <label className="arrival-field" data-pointer={byPointer || undefined} onFocus={() => setByPointer(!lastInputWasKeyboard())} onKeyDown={() => setByPointer(false)}>
            <span className="arrival-text" aria-hidden="true" data-testid="arrival-text">
              {fmtDay(arrival)}
            </span>
            <svg className="arrival-icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <rect x="2.5" y="4" width="15" height="13.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M2.5 8h15M6.5 2v4M13.5 2v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              type="date"
              className="arrival-input"
              aria-label={STRINGS.planner.arrivalInput}
              value={arrival}
              min={ymd(first)}
              max={ymd(last)}
              onChange={(e) => e.target.value && goDay(Date.parse(e.target.value))}
              onClick={(e) => openPicker(e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  openPicker(e.currentTarget);
                }
              }}
            />
          </label>
          <button type="button" className="icon-btn" aria-label={STRINGS.planner.nextDay} onClick={() => goDay(Date.parse(arrival) + DAY_MS)} disabled={Date.parse(arrival) >= last}>
            ›
          </button>
        </div>
        <div className="day-strip" role="group" aria-label={STRINGS.planner.strip(siteName(plan.site_id))}>
          {days.map((day) => {
            const m = index ? lookup(index, plan.site_id, day) : null;
            const selected = day === arrival;
            return (
              <button
                key={day}
                type="button"
                className="day-cell"
                aria-pressed={selected}
                aria-label={STRINGS.planner.dayCell(fmtDay(day), m ? round(m.score, 2) : null)}
                title={STRINGS.planner.dayCell(fmtDay(day), m ? round(m.score, 2) : null)}
                style={{ background: m ? lut[lutIndex("combined", m.score)] : undefined }}
                onClick={() => goDay(Date.parse(day))}
                data-day-index={index ? dayIndex(index, day) : undefined}
              />
            );
          })}
        </div>
        <p className="sidebar-hint">{STRINGS.planner.stripHint}</p>
      </section>

      <section className="sidebar-block" aria-labelledby="stay-label">
        <h2 id="stay-label" className="sidebar-label">
          {STRINGS.planner.stay}
        </h2>
        <div className="segmented" role="group" aria-labelledby="stay-label">
          {windows.map((d) => (
            <button key={d} type="button" aria-pressed={plan.window_days === d} onClick={() => setWindow(d)}>
              {STRINGS.planner.days(d)}
            </button>
          ))}
        </div>
      </section>

      <section className="sidebar-block" aria-labelledby="site-label">
        <h2 id="site-label" className="sidebar-label">
          {STRINGS.planner.site}
        </h2>
        <ul className="site-list">
          {sites.map((s) => {
            const m = index ? lookup(index, s.id, arrival) : null;
            const v = m ? planVerdict(m) : null;
            return (
              <li key={s.id}>
                <button type="button" className="site-row" aria-pressed={s.id === plan.site_id} onClick={() => selectSite(s.id)}>
                  <span className="site-name">{s.name}</span>
                  {/* B2: the Sun and the Earth together, with marks for each (shape, not colour alone); green only when both hold */}
                  {v && (
                    <span className="site-status" data-tone={v.tone} title={m ? STRINGS.planner.sun(round(m.sun_pct, 1)) : undefined}>
                      <span className="visually-hidden">, </span>
                      <VerdictMarks sun={v.sun} earth={v.earth} />
                      {`${STRINGS.planner.statusSun(v.darkH)} · ${STRINGS.planner.statusEarth(v.earth, v.gapH)}`}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="sidebar-actions">
        <button type="button" className="btn ghost" onClick={onOpenSearch}>
          {STRINGS.planner.search(pinned)}
        </button>
        <button type="button" className="btn primary launch-btn" onClick={onLaunch}>
          {STRINGS.planner.launch(fmtDay(plan.launch_utc))}
        </button>
      </div>
    </aside>
  );
}
