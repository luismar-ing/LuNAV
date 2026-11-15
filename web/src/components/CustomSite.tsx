import { useEffect, useMemo, useState } from "react";
import type { Horizon, Plan, Site, WindowRow } from "../lib/contract";
import { analyseCustomSite, latLonToPolar, parseCoordinates, type SkyData, type CustomTerrain } from "../lib/customSite";
import { lookup } from "../lib/constraints";
import { fmtDay, fmtUtc } from "../lib/format";
import type { PlanData } from "../lib/planData";
import { planVerdict } from "../lib/siteBrief";
import { STRINGS } from "../lib/strings";
import { num } from "../lib/why";
import { appStore, useApp } from "../store/appStore";
import { Panorama } from "../views/Panorama";
import { PointPicker } from "./PointPicker";
import { VerdictMarks } from "./VerdictMarks";

const C = STRINGS.custom;
const DAY_MS = 86_400_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const coord = (v: number) => v.toFixed(3);

/** Better first: more sunlight, shorter night, more Earth time, shorter comm gap, earlier arrival. */
function compareDays(a: Omit<WindowRow, "score">, b: Omit<WindowRow, "score">): number {
  return (
    b.sun_pct - a.sun_pct || a.longest_dark_h - b.longest_dark_h || b.earth_h_mean - a.earth_h_mean || a.longest_comm_gap_h - b.longest_comm_gap_h || a.start.localeCompare(b.start)
  );
}

/**
 * NASA LOLA long-term average sunlight (Mazarico et al. 2011) at a point, read from the lit polar map the Moon map
 * already shows. An independent check of the computed sunlight; silently absent where the browser cannot read
 * pixels (tests) or outside the map.
 */
function useLolaSunlight(lat: number | null, lon: number | null): number | null {
  const [value, setValue] = useState<number | null>(null);
  useEffect(() => {
    setValue(null);
    if (lat === null || lon === null) return;
    let alive = true;
    const data = appStore.getState().data;
    void data
      .illumination()
      .then((h) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx || !alive) return;
          const [x, y] = latLonToPolar(lat, lon);
          const { left, right, top, bottom } = h.extent_m;
          const col = Math.floor(((x - left) / (right - left)) * img.naturalWidth);
          const row = Math.floor(((top - y) / (top - bottom)) * img.naturalHeight);
          if (col < 0 || row < 0 || col >= img.naturalWidth || row >= img.naturalHeight) return;
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          ctx.drawImage(img, 0, 0);
          setValue(ctx.getImageData(col, row, 1, 1).data[0] / 255);
        };
        img.src = data.illuminationImageUrl();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [lat, lon]);
  return value;
}

/**
 * Custom coordinates (B12, decision A13): the challenge asks for "the ability to input custom lunar coordinates".
 * Any point from 85°S to the pole: the Sun and the Earth from SPICE vectors (lib/customSite), the horizon traced
 * from the exact coordinate over the reduced LOLA relief, the spec 5.5 metrics for the chosen arrival and stay, the best arrival
 * days there, the five candidate sites side by side, and the site's 360° panorama. All 2D (SVG), no WebGL.
 */
export function CustomSite({ onLaunch, onLand }: { onLaunch?(): void; onLand?(): void } = {}) {
  const plan = useApp((s) => (s.selectedPlanId ? s.plansById.get(s.selectedPlanId) : undefined));
  const sites = useApp((s) => s.sites);
  const manifest = useApp((s) => s.manifest);
  const indexes = useApp((s) => s.windowIndex);
  const loadWindows = useApp((s) => s.loadWindows);

  const site = sites.find((s) => s.id === plan?.site_id);
  // a click on the planner's Moon map opens the panel on that point; otherwise on the selected site
  const start = appStore.getState().customAt ?? (site ? { lat: site.lat, lon: site.lon } : null);
  const fmtPair = (c: { lat: number; lon: number }) => `${Number(c.lat.toFixed(4))}, ${Number(c.lon.toFixed(4))}`;
  const [text, setText] = useState(start ? fmtPair(start) : "");
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(start);
  const [error, setError] = useState<string | null>(null);
  const [stay, setStay] = useState<number>(plan?.window_days ?? 7);
  const first = manifest?.date_range.arrival_start.slice(0, 10) ?? "2027-01-01";
  const last = manifest?.date_range.arrival_end.slice(0, 10) ?? "2027-12-31";
  const [arrival, setArrival] = useState(plan?.arrival_utc.slice(0, 10) ?? first);
  const [offsetH, setOffsetH] = useState(0);
  const [data, setData] = useState<{
    sky: SkyData;
    terrain: CustomTerrain;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [going, setGoing] = useState(false);

  useEffect(() => {
    const store = appStore.getState().data;
    Promise.all([store.sky(), store.terrainCustom()])
      .then(([sky, terrain]) => setData({ sky, terrain }))
      .catch((e: Error) => setLoadError(e.message));
  }, []);
  useEffect(() => {
    void loadWindows(stay);
  }, [stay, loadWindows]);

  const nArrivals = Math.round((Date.parse(last) - Date.parse(first)) / DAY_MS) + 1;
  const params = manifest?.params;
  const result = useMemo(() => {
    if (!data || !coords || !params) return null;
    return analyseCustomSite(data.sky, data.terrain, coords.lat, coords.lon, stay, nArrivals, {
      sunRadiusDeg: params.sun_radius_deg,
      antennaMarginDeg: params.antenna_margin_deg,
    });
  }, [data, coords, stay, nArrivals, params]);
  const lola = useLolaSunlight(result ? coords!.lat : null, result ? coords!.lon : null);

  const dayIdx = Math.round((Date.parse(arrival) - Date.parse(first)) / DAY_MS);
  const row = result?.rows[dayIdx];
  const best = useMemo(() => (result ? [...result.rows].sort(compareDays).slice(0, 3) : []), [result]);

  // the panorama of the stay at this point: the app's own Panorama with a plan-shaped object
  const planData = useMemo((): PlanData | null => {
    if (!result || !row) return null;
    const spd = 1440 / result.sky.stepMin;
    const k0 = dayIdx * spd;
    const n = stay * spd;
    const f32 = (a: Float64Array) => Float32Array.from(a.subarray(k0, k0 + n));
    const name = C.heading(coord(result.lat), coord(result.lon));
    return {
      plan: {
        id: "custom",
        site_id: "custom",
        arrival_utc: `${arrival}T00:00:00Z`,
        window_days: stay,
      } as unknown as Plan,
      site: {
        id: "custom",
        name,
        lat: result.lat,
        lon: result.lon,
        elevation_m: result.point.elevationM,
      } as unknown as Site,
      horizon: {
        site_id: "custom",
        az_step_deg: data!.terrain.header.az_step_deg,
        h_obs_m: data!.terrain.header.h_obs_m,
        r_max_km: data!.terrain.header.r_max_km,
        elev_deg: Array.from(result.point.mask),
      } as Horizon,
      series: {
        startMs: Date.parse(`${arrival}T00:00:00Z`),
        stepMin: result.sky.stepMin,
        n,
        sunAz: f32(result.sky.sunAz),
        sunEl: f32(result.sky.sunEl),
        earthAz: f32(result.sky.earthAz),
        earthEl: f32(result.sky.earthEl),
        sunVis: result.sun.slice(k0, k0 + n),
        earthVis: result.earth.slice(k0, k0 + n),
      },
      metrics: { ...row, score: 0 },
    };
  }, [result, row, dayIdx, stay, arrival, data]);

  const pick = (lat: number, lon: number) => {
    const c = { lat: Number(lat.toFixed(4)), lon: Number(lon.toFixed(4)) };
    setText(fmtPair(c));
    setError(null);
    setCoords(c);
    setOffsetH(0);
  };
  const analyse = (t = text) => {
    const c = parseCoordinates(t);
    if (!c) return setError(C.invalid);
    setError(null);
    setCoords(c);
    setOffsetH(0);
  };
  // B13 (decision A14): the point becomes a site of its own and the plan of this arrival and stay is selected; the
  // planner then flies the whole journey to it (or opens the site directly), as for the five candidate sites
  const go = async (then: (() => void) | undefined) => {
    if (!coords || !then || going) return;
    setGoing(true);
    try {
      const st = appStore.getState();
      const id = await st.addCustomSite(coords.lat, coords.lon);
      const planId = id ? `${id}_${arrival.replace(/-/g, "")}_${stay}d` : null;
      if (!planId || !appStore.getState().plansById.has(planId)) return;
      appStore.getState().selectPlan(planId);
      appStore.getState().setCustomOpen(false);
      then();
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setGoing(false);
    }
  };
  const outside = data && coords && !result;
  const index = indexes[stay];
  const timeMs = Date.parse(`${arrival}T00:00:00Z`) + offsetH * 3_600_000;

  return (
    <div className="custom-site" data-testid="custom-site">
      <p className="finder-intro">{C.intro}</p>
      <div className="custom-input">
        <form
          className="custom-form"
          onSubmit={(e) => {
            e.preventDefault();
            analyse();
          }}
        >
          <label htmlFor="custom-coords" className="sidebar-label">
            {C.label}
          </label>
          <div className="nl-row">
            <input id="custom-coords" className="nl-input" value={text} placeholder={C.placeholder} onChange={(e) => setText(e.target.value)} aria-describedby="custom-error" />
            <button type="submit" className="btn primary">
              {C.analyse}
            </button>
          </div>
          <p id="custom-error" className="nl-result" role="status" aria-live="polite">
            {error ?? (outside && data ? C.outside(data.terrain.header.lat_limit_deg) : "")}
          </p>
          <div className="custom-presets">
            {sites.map((s) => (
              <button
                key={s.id}
                type="button"
                className="btn ghost"
                title={C.useSite(s.name)}
                onClick={() => {
                  const t = `${s.lat}, ${s.lon}`;
                  setText(t);
                  analyse(t);
                }}
              >
                {s.name.replace(/ \(.*\)$/, "")}
              </button>
            ))}
          </div>
        </form>
        <PointPicker lat={coords?.lat ?? null} lon={coords?.lon ?? null} limitDeg={data?.terrain.header.lat_limit_deg ?? -85} onPick={pick} />
      </div>

      {loadError && <p className="nl-result">{loadError}</p>}
      {!data && !loadError && <p className="finder-summary">{C.loading}</p>}

      {result && row && planData && (
        <>
          <div className="custom-head">
            <h3 className="custom-title">{C.heading(coord(result.lat), coord(result.lon))}</h3>
            <span className="badge assumed" title={C.approxTitle} data-testid="custom-approx">
              {C.approx}
            </span>
          </div>
          {(onLaunch || onLand) && (
            <div className="custom-go" data-testid="custom-go">
              {onLaunch && (
                <button type="button" className="btn primary" title={C.launchHereTitle} disabled={going} onClick={() => void go(onLaunch)}>
                  {C.launchHere}
                </button>
              )}
              {onLand && (
                <button type="button" className="btn ghost" title={C.landHereTitle} disabled={going} onClick={() => void go(onLand)}>
                  {C.landHere}
                </button>
              )}
              <p className="finder-method" role="status" aria-live="polite">
                {going ? C.preparing : C.journeyNote}
              </p>
            </div>
          )}
          <p className="finder-method" data-testid="custom-terrain-note">
            {C.terrainNote(result.point.elevationM.toFixed(0))}
          </p>

          <div className="custom-controls">
            <div className="finder-field">
              <span className="sidebar-label" id="custom-stay-label">
                {C.stay}
              </span>
              <div className="segmented" role="group" aria-labelledby="custom-stay-label">
                {(manifest?.params.window_days ?? [3, 7, 14]).map((d) => (
                  <button key={d} type="button" aria-pressed={stay === d} onClick={() => setStay(d)}>
                    {STRINGS.planner.days(d)}
                  </button>
                ))}
              </div>
            </div>
            <label className="finder-field">
              <span className="sidebar-label">
                {C.arrival} · {fmtDay(arrival)}
              </span>
              <input
                type="date"
                className="finder-date"
                aria-label={C.arrivalInput}
                value={arrival}
                min={first}
                max={last}
                onChange={(e) => {
                  if (!e.target.value) return;
                  setArrival(ymd(Math.min(Date.parse(last), Math.max(Date.parse(first), Date.parse(e.target.value)))));
                  setOffsetH(0);
                }}
              />
            </label>
          </div>

          <section aria-labelledby="custom-metrics-title" className="custom-metrics">
            <h4 id="custom-metrics-title" className="sidebar-label">
              {C.metrics}
            </h4>
            {(() => {
              const v = planVerdict(row);
              return (
                <p className="site-status" data-tone={v.tone} data-testid="custom-verdict">
                  <VerdictMarks sun={v.sun} earth={v.earth} />
                  {`${STRINGS.planner.statusSun(v.darkH)} · ${STRINGS.planner.statusEarth(v.earth, v.gapH)}`}
                </p>
              );
            })()}
            <table className="custom-table" data-testid="custom-table">
              <thead>
                <tr>
                  <th scope="col">{C.site}</th>
                  <th scope="col">{C.sun}</th>
                  <th scope="col">{C.dark}</th>
                  <th scope="col">{C.earthMin}</th>
                  <th scope="col">{C.earthMean}</th>
                  <th scope="col">{C.gap}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="custom-this">
                  <th scope="row">{C.thisPoint}</th>
                  <td>{num(row.sun_pct)} %</td>
                  <td>{num(row.longest_dark_h)} h</td>
                  <td>{num(row.earth_h_min)} h</td>
                  <td>{num(row.earth_h_mean)} h</td>
                  <td>{num(row.longest_comm_gap_h)} h</td>
                </tr>
                {index &&
                  sites.map((s) => {
                    const m = lookup(index, s.id, arrival);
                    if (!m) return null;
                    return (
                      <tr key={s.id}>
                        <th scope="row">{s.name.replace(/ \(.*\)$/, "")}</th>
                        <td>{num(m.sun_pct)} %</td>
                        <td>{num(m.longest_dark_h)} h</td>
                        <td>{num(m.earth_h_min)} h</td>
                        <td>{num(m.earth_h_mean)} h</td>
                        <td>{num(m.longest_comm_gap_h)} h</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            <p className="finder-method">{C.sites}</p>
            {lola !== null && (
              <p className="finder-method" data-testid="custom-lola">
                {C.lola(num(lola * 100))}
              </p>
            )}
          </section>

          <section aria-labelledby="custom-best-title">
            <h4 id="custom-best-title" className="sidebar-label">
              {C.bestDays}
            </h4>
            <div className="custom-presets">
              {best.map((b) => (
                <button
                  key={b.start}
                  type="button"
                  className="btn ghost"
                  aria-pressed={b.start.slice(0, 10) === arrival}
                  onClick={() => {
                    setArrival(b.start.slice(0, 10));
                    setOffsetH(0);
                  }}
                >
                  {C.bestDay(fmtDay(b.start), num(b.sun_pct), b.longest_dark_h === 0 ? C.noNight : C.night(num(b.longest_dark_h)))}
                </button>
              ))}
            </div>
          </section>

          <section className="custom-panorama">
            <label className="finder-field">
              <span className="sidebar-label">
                {C.time} · {fmtUtc(timeMs)}
              </span>
              <input
                type="range"
                min={0}
                max={stay * 24 - 0.5}
                step={0.5}
                value={offsetH}
                aria-label={C.time}
                aria-valuetext={fmtUtc(timeMs)}
                onChange={(e) => setOffsetH(Number(e.target.value))}
              />
            </label>
            <Panorama data={planData} timeMs={timeMs} />
          </section>
          <p className="finder-method">{C.method}</p>
        </>
      )}
    </div>
  );
}
