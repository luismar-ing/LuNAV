import { useEffect, useMemo, useState } from "react";
import { fmtDay, fmtShortDay } from "../lib/format";
import {
  countValid,
  relaxations,
  search,
  type FinderOrder,
} from "../lib/optimizer";
import { planVerdict } from "../lib/siteBrief";
import { STRINGS } from "../lib/strings";
import { fmtMetric, num } from "../lib/why";
import { useApp, type Constraints } from "../store/appStore";
import { ConstraintControls, markConstraintChange } from "./ConstraintControls";
import { VerdictMarks } from "./VerdictMarks";

const F = STRINGS.finder;

/**
 * "Find the best plan" (B11, decision A12). The planner sets the spec 5.6 limits (sliders or a sentence), the stay
 * and the arrival range; every plan of that stay is checked (lib/optimizer) and the best plan of each site is
 * listed with why, how many arrival days work there and the run of days around it. "Select" makes it the plan of
 * the Moon map and the site brief; "Pin" adds it to the comparison tray. All 2D, nothing new in WebGL.
 */
export function BestPlanFinder({ onSelected }: { onSelected(): void }) {
  const plan = useApp((s) =>
    s.selectedPlanId ? s.plansById.get(s.selectedPlanId) : undefined,
  );
  const sites = useApp((s) => s.sites);
  const range = useApp((s) => s.manifest?.date_range);
  const windows = useApp((s) => s.manifest?.params.window_days ?? [3, 7, 14]);
  const weights = useApp((s) => s.manifest?.params.score_weights);
  const constraints = useApp((s) => s.constraints);
  const setConstraints = useApp((s) => s.setConstraints);
  const indexes = useApp((s) => s.windowIndex);
  const loadWindows = useApp((s) => s.loadWindows);
  const comparePlans = useApp((s) => s.comparePlans);
  const selectPlan = useApp((s) => s.selectPlan);
  const pinPlan = useApp((s) => s.pinPlan);

  const [stay, setStay] = useState<number>(plan?.window_days ?? 7);
  const first = range?.arrival_start.slice(0, 10) ?? "";
  const last = range?.arrival_end.slice(0, 10) ?? "";
  const [from, setFrom] = useState(first);
  const [to, setTo] = useState(last);
  const [order, setOrder] = useState<FinderOrder>("best");

  // every stay is loaded: the chosen one is searched, the others give the "other stays" counts
  useEffect(() => {
    for (const L of windows) void loadWindows(L);
  }, [windows, loadWindows]);

  const query = useMemo(
    () => ({ constraints, from: from || null, to: to || null, order }),
    [constraints, from, to, order],
  );
  const index = indexes[stay];
  const result = useMemo(
    () => (index ? search(index, query) : null),
    [index, query],
  );
  const relax = useMemo(
    () =>
      index && result && result.valid === 0 ? relaxations(index, query) : [],
    [index, query, result],
  );
  const others = windows
    .filter((L) => L !== stay)
    .map((L) => ({ L, n: indexes[L] ? countValid(indexes[L]!, query) : null }));

  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  const pct = (w: number) =>
    weights
      ? Math.round((100 * w) / (weights.w1 + weights.w2 + weights.w3))
      : 0;
  const apply = (patch: Partial<Constraints>) => {
    markConstraintChange();
    setConstraints(patch);
  };
  const choose = (planId: string) => {
    selectPlan(planId); // also sets the stay length of the sidebar

    onSelected();
  };

  return (
    <div className="finder" data-testid="best-plan-finder">
      <div className="finder-controls">
        <p className="finder-intro">{F.intro}</p>
        <ConstraintControls />

        <div className="finder-options">
          <div className="finder-field">
            <span className="sidebar-label" id="finder-stay-label">
              {F.stay}
            </span>
            <div
              className="segmented"
              role="group"
              aria-labelledby="finder-stay-label"
            >
              {windows.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={stay === d}
                  onClick={() => setStay(d)}
                >
                  {STRINGS.planner.days(d)}
                </button>
              ))}
            </div>
          </div>
          <label className="finder-field">
            <span className="sidebar-label">
              {F.from} · {from ? fmtDay(from) : "—"}
            </span>
            <input
              type="date"
              className="finder-date"
              aria-label={F.fromInput}
              value={from}
              min={first}
              max={to || last}
              onChange={(e) => setFrom(e.target.value || first)}
            />
          </label>
          <label className="finder-field">
            <span className="sidebar-label">
              {F.to} · {to ? fmtDay(to) : "—"}
            </span>
            <input
              type="date"
              className="finder-date"
              aria-label={F.toInput}
              value={to}
              min={from || first}
              max={last}
              onChange={(e) => setTo(e.target.value || last)}
            />
          </label>
          <div className="finder-field">
            <span className="sidebar-label" id="finder-order-label">
              {F.order}
            </span>
            <div
              className="segmented"
              role="group"
              aria-labelledby="finder-order-label"
            >
              <button
                type="button"
                aria-pressed={order === "best"}
                onClick={() => setOrder("best")}
              >
                {F.orderBest}
              </button>
              <button
                type="button"
                aria-pressed={order === "earliest"}
                onClick={() => setOrder("earliest")}
              >
                {F.orderEarliest}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="finder-output">
        {!result ? (
          <p className="finder-summary">{F.loading}</p>
        ) : (
          <>
            <p
              className="finder-summary"
              role="status"
              aria-live="polite"
              data-testid="finder-summary"
            >
              {F.summary(result.valid, result.evaluated, stay)}
            </p>
            <p className="finder-others">
              <span>{F.otherStays}:</span>
              {others.map(({ L, n }) => (
                <button
                  key={L}
                  type="button"
                  className="btn ghost finder-other"
                  title={F.otherStayTitle(L)}
                  disabled={n === null}
                  onClick={() => setStay(L)}
                >
                  {F.otherStay(L, n ?? 0)}
                </button>
              ))}
            </p>

            {result.bySite.length > 0 ? (
              <section aria-labelledby="finder-results-title">
                <h3 id="finder-results-title" className="sidebar-label">
                  {F.results}
                </h3>
                <ol className="finder-results">
                  {result.bySite.map((r, i) => {
                    const v = planVerdict(r.row);
                    const name = siteName(r.siteId);
                    const date = fmtDay(r.arrival);
                    const isPinned = comparePlans.includes(r.planId);
                    return (
                      <li
                        key={r.siteId}
                        className="finder-result"
                        data-plan-id={r.planId}
                      >
                        <div className="finder-result-head">
                          <span className="finder-rank">{F.rank(i + 1)}</span>
                          <span className="finder-site">{name}</span>
                          <span className="finder-date-text">{date}</span>
                        </div>
                        <p className="site-status" data-tone={v.tone}>
                          <VerdictMarks sun={v.sun} earth={v.earth} />
                          {`${STRINGS.planner.statusSun(v.darkH)} · ${STRINGS.planner.statusEarth(v.earth, v.gapH)}`}
                        </p>
                        <p className="finder-metrics">
                          {F.metrics(
                            num(r.row.sun_pct),
                            num(r.row.longest_dark_h),
                            num(r.row.earth_h_min),
                            fmtMetric("score", r.row.score),
                          )}
                        </p>
                        <p className="finder-run">
                          {F.run(
                            fmtShortDay(r.run.from),
                            fmtShortDay(r.run.to),
                            r.run.days,
                          )}{" "}
                          · {F.validDays(r.validDays)}
                        </p>
                        <div className="finder-actions">
                          <button
                            type="button"
                            className="btn primary"
                            aria-label={F.selectAria(name, date)}
                            onClick={() => choose(r.planId)}
                          >
                            {F.select}
                          </button>
                          <button
                            type="button"
                            className="btn ghost"
                            aria-label={F.pinAria(name, date)}
                            aria-pressed={isPinned}
                            disabled={isPinned}
                            onClick={() => pinPlan(r.planId)}
                          >
                            {isPinned ? F.pinned : F.pin}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ) : (
              <section className="finder-none" data-testid="finder-none">
                <p>{F.none}</p>
                {relax.length > 0 && (
                  <p className="finder-none-hint">{F.noneHint}</p>
                )}
                <ul>
                  {relax.map((r) => {
                    if (r.suggested === null)
                      return <li key={r.key}>{F.relaxNone[r.key]}</li>;
                    const shown = num(r.suggested);
                    return (
                      <li key={r.key}>
                        {F.relax[r.key](num(r.reachable!))}{" "}
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() => apply({ [r.key]: r.suggested })}
                        >
                          {F.use(
                            r.key === "minSunPct"
                              ? `${shown} %`
                              : r.key === "maxDarkH"
                                ? `${shown} h`
                                : `${shown} h/day`,
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {weights && (
              <p className="finder-method">
                {F.method(result.evaluated, {
                  sun: pct(weights.w1),
                  dark: pct(weights.w2),
                  earth: pct(weights.w3),
                })}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
