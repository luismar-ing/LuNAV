import { useState } from "react";
import { createPortal } from "react-dom";
import { Drawer } from "../components/Drawer";
import { ErrorMessage } from "../components/ErrorMessage";
import { describeError } from "../lib/errors";
import type { PlanData } from "../lib/planData";
import { STRINGS } from "../lib/strings";
import { bestBadges, fmtMetric, METRICS } from "../lib/why";
import { MetricsBox } from "../panels2d/MetricsBox";
import { TimeRibbon } from "../panels2d/TimeRibbon";
import { useApp } from "../store/appStore";
import { Panorama } from "./Panorama";
import { SitePanel } from "./SitePanel";
import { useSiteData } from "./useSiteData";
import { NextEvents, TimeLeft } from "./TimeLeft";
import { useTimeseries } from "./useTimeseries";

/**
 * Arrival at the site in the Mission Planner (decision A7: layout of B3; planner redesign: REDIS screen 3 in the
 * 3C style). The 3D sky stays on top; the "Time left" card on the right counts down to the next sunset and
 * Earthset (with "Site details" for the full panel of spec 8.6: location, daily values, nearby features, each with
 * its source); the bottom console holds the 360° horizon panorama (8.4, level A) and the time ribbon on the mission
 * clock, and beside them what happens next and the window metrics against the other pinned plans (★ = best).
 * "Hide 2D view" folds the console away so the 3D site can be seen whole.
 * `display: contents`: its parts take their places in the journey's grid (MissionStage).
 */
export function SiteLayout() {
  const missionTime = useApp((s) => s.missionTime);
  const compareTime = useApp((s) => s.compareTime);
  const limit = useApp((s) => s.constraints.maxDarkH);
  const { plan, site, pinned, error, retry } = useSiteData();
  const series = useTimeseries(plan?.site.id);
  const [details, setDetails] = useState(false);
  const [show2d, setShow2d] = useState(true);
  const [tab, setTab] = useState<"next" | "metrics">("next");
  const levelB = useApp((s) => s.levelB);
  const setLevelB = useApp((s) => s.setLevelB);
  const surfaceView = useApp((s) => s.surfaceView);
  const setSurfaceView = useApp((s) => s.setSurfaceView);
  const others = plan ? pinned.filter((p) => p.plan.id !== plan.plan.id) : [];
  const best = plan
    ? bestBadges([plan.metrics, ...others.map((p) => p.metrics)])[0]
    : new Set<never>();
  const endMs = plan ? plan.series.startMs + plan.plan.window_days * 86_400_000 : 0;

  return (
    <section
      className="site-layout"
      data-testid="live-site"
      aria-labelledby="live-site-title"
    >
      <h3 id="live-site-title" className="visually-hidden">
        {STRINGS.site.title}
      </h3>
      {error !== null && (
        <div className="site-console glass">
          <ErrorMessage
            what={STRINGS.errors.site}
            info={describeError(error)}
            onRetry={retry}
          />
        </div>
      )}
      {error === null && (!plan || !site || missionTime === null) && (
        <p className="site-console glass placeholder">{STRINGS.loading}</p>
      )}
      {plan && site && missionTime !== null && (
        <>
          <aside
            className="site-card glass"
            aria-label={STRINGS.siteLayout.timeLeft}
          >
            {series.error !== null && <ErrorMessage what={STRINGS.errors.site} info={describeError(series.error)} onRetry={series.retry} />}
            {series.error === null && !series.ts && <p className="site-card-label">{STRINGS.loading}</p>}
            {series.ts && <TimeLeft plan={plan} ts={series.ts} timeMs={missionTime} limitH={limit} />}
            <div className="site-card-actions">
              <button
                type="button"
                className="btn ghost"
                onClick={() => setDetails(true)}
              >
                {STRINGS.siteLayout.details}
              </button>
              {/* T6.1.c: Level B can be turned off; the MVP scene and every 2D view stay as they are */}
              <button
                type="button"
                className="btn ghost"
                aria-pressed={levelB}
                title={STRINGS.siteLayout.levelBTitle}
                onClick={() => setLevelB(!levelB)}
              >
                <span aria-hidden="true">{levelB ? "■" : "□"}</span>{" "}
                {STRINGS.siteLayout.levelB}
              </button>
              {/* TR.3.a: the first-person sky (Level B) or the aerial framing of the site */}
              {levelB && (
                <button
                  type="button"
                  className="btn ghost"
                  title={STRINGS.siteLayout.standTitle}
                  onClick={() => setSurfaceView(!surfaceView)}
                >
                  {surfaceView
                    ? STRINGS.siteLayout.aerial
                    : STRINGS.siteLayout.stand}
                </button>
              )}
            </div>
          </aside>
          {show2d ? (
            <div className="site-console glass" data-testid="site-console">
              <div className="site-console-main">
                <Panorama data={plan} timeMs={missionTime} />
                <TimeRibbon series={plan.series} compareTime={compareTime} thin />
              </div>
              <div className="site-side">
                <div className="site-side-head">
                  <div className="site-tabs" role="tablist" aria-label={STRINGS.siteLayout.side}>
                    {(["next", "metrics"] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        role="tab"
                        id={`site-tab-${t}`}
                        aria-selected={tab === t}
                        aria-controls={`site-panel-${t}`}
                        tabIndex={tab === t ? 0 : -1}
                        onClick={() => setTab(t)}
                        onKeyDown={(e) => {
                          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                            const next = t === "next" ? "metrics" : "next";
                            setTab(next);
                            document.getElementById(`site-tab-${next}`)?.focus();
                          }
                        }}
                      >
                        {t === "next" ? STRINGS.siteLayout.next : STRINGS.siteLayout.metrics}
                      </button>
                    ))}
                  </div>
                  <button type="button" className="btn ghost pill console-toggle" title={STRINGS.siteLayout.hide2dTitle} onClick={() => setShow2d(false)}>
                    {STRINGS.siteLayout.hide2d}
                  </button>
                </div>
                <div role="tabpanel" id="site-panel-next" aria-labelledby="site-tab-next" hidden={tab !== "next"}>
                  {series.ts ? <NextEvents ts={series.ts} timeMs={missionTime} endMs={endMs} /> : <p className="muted-note">{STRINGS.loading}</p>}
                </div>
                <div role="tabpanel" id="site-panel-metrics" aria-labelledby="site-tab-metrics" hidden={tab !== "metrics"}>
                  <MetricsBox metrics={plan.metrics} best={best} />
                  {others.length > 0 && <CompareTable plan={plan} others={others} />}
                </div>
              </div>
            </div>
          ) : (
            <div className="site-console-folded">
              <button type="button" className="btn ghost pill console-toggle" onClick={() => setShow2d(true)}>
                {STRINGS.siteLayout.show2d}
              </button>
            </div>
          )}
          {/* rendered in the Mission Planner's root layer: above the journey panels (which may scroll) and
              below the tool bar, like the search panel */}
          {details &&
            createPortal(
              <Drawer
                title={STRINGS.siteLayout.detailsTitle(plan.site.name)}
                closeLabel={STRINGS.planner.closeSearch}
                onClose={() => setDetails(false)}
                testId="site-details"
              >
                <SitePanel
                  plan={plan}
                  features={site.features}
                  daily={site.daily}
                  pinned={pinned}
                />
              </Drawer>,
              document.querySelector(".planner") ?? document.body,
            )}
        </>
      )}
    </section>
  );
}

/** Every metric of this plan against the other pinned ones; ★ marks the best of each row (shape, not colour). */
function CompareTable({
  plan,
  others,
}: {
  plan: PlanData;
  others: PlanData[];
}) {
  const rows = [plan, ...others];
  const best = bestBadges(rows.map((p) => p.metrics));
  return (
    <div className="site-compare-mini table-scroll">
      <table className="compare-table" data-testid="site-compare-mini">
        <caption className="site-card-label">
          {STRINGS.siteLayout.compare}
        </caption>
        <thead>
          <tr>
            <th scope="col">{STRINGS.sitePanel.short.metric}</th>
            {rows.map((p, i) => (
              <th
                key={p.plan.id}
                scope="col"
                className={i === 0 ? "this-plan" : ""}
                title={`${p.site.name} · ${p.plan.arrival_utc.slice(0, 10)}`}
              >
                {i === 0 ? STRINGS.siteLayout.thisPlan : p.site.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {METRICS.map(({ key }) => (
            <tr key={key}>
              <th scope="row">{STRINGS.metricNames[key]}</th>
              {rows.map((p, i) => (
                <td key={p.plan.id} data-best={best[i].has(key)}>
                  {fmtMetric(key, p.metrics[key])}
                  {best[i].has(key) && (
                    <span aria-label={STRINGS.panel.best}> ★</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
