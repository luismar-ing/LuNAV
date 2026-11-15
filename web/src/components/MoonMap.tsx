import { useEffect, useMemo, useState } from "react";
import type { Site } from "../lib/contract";
import type { IlluminationHeader } from "../lib/data";
import { distanceKm, mapFraction } from "../lib/moonMap";
import type { Verdict } from "../lib/siteBrief";
import { STRINGS } from "../lib/strings";
import { useApp } from "../store/appStore";

/** How a site fares for the chosen dates, Sun and Earth together (B2), or undefined while not known yet. */
export type SiteTone = Verdict | undefined;

/**
 * Moon map of the Mission Planner (planner redesign: REDIS screen 1 with the 3C porthole). The published LOLA
 * average illumination of the south pole (Mazarico et al. 2011, the same map as the 3D landing's polar layer) in a
 * circle, with one button per landing site at its real place and a line to the nearest other site with the
 * distance. Choosing a pin selects that site, like the list in the sidebar. 2D only: no WebGL (rule 7).
 */
export function MoonMap({ sites, selectedId, tone, onSelect }: { sites: Site[]; selectedId: string; tone(id: string): SiteTone; onSelect(id: string): void }) {
  const data = useApp((s) => s.data);
  const [header, setHeader] = useState<IlluminationHeader | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    data
      .illumination()
      .then((h) => alive && setHeader(h))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [data]);

  const pins = useMemo(
    () => (header ? sites.map((s) => ({ site: s, ...mapFraction(header.extent_m, s.lat, s.lon) })).filter((p) => p.fx >= 0 && p.fx <= 1 && p.fy >= 0 && p.fy <= 1) : []),
    [header, sites],
  );
  const selected = pins.find((p) => p.site.id === selectedId);
  // the nearest other site: how small a move it takes to change everything
  const nearest = useMemo(() => {
    if (!selected) return null;
    let best: { p: (typeof pins)[number]; km: number } | null = null;
    for (const p of pins) {
      if (p.site.id === selectedId) continue;
      const km = distanceKm(selected.site, p.site);
      if (!best || km < best.km) best = { p, km };
    }
    return best;
  }, [pins, selected, selectedId]);
  const widthKm = header ? Math.round((header.extent_m.right - header.extent_m.left) / 10_000) * 10 : 0;

  return (
    <figure className="moon-map" aria-label={STRINGS.planner.map} data-testid="moon-map">
      <div className="moon-map-disc">
        <img src={data.illuminationImageUrl()} alt="" draggable={false} />
        {selected && nearest && (
          <>
            <svg className="moon-map-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <line x1={selected.fx * 100} y1={selected.fy * 100} x2={nearest.p.fx * 100} y2={nearest.p.fy * 100} vectorEffect="non-scaling-stroke" />
            </svg>
            <span
              className="moon-map-km"
              title={STRINGS.planner.nearestTitle(selected.site.name, nearest.p.site.name, Math.round(nearest.km))}
              style={{ left: `${((selected.fx + nearest.p.fx) / 2) * 100}%`, top: `${((selected.fy + nearest.p.fy) / 2) * 100}%` }}
            >
              {STRINGS.planner.nearest(Math.round(nearest.km))}
            </span>
          </>
        )}
        {pins.map(({ site, fx, fy }) => {
          const on = site.id === selectedId;
          const v = tone(site.id);
          return (
            <button
              key={site.id}
              type="button"
              className="moon-pin"
              aria-pressed={on}
              data-tone={v?.tone}
              data-sun={v?.sun}
              data-earth={v?.earth}
              title={v ? `${STRINGS.planner.statusSun(v.darkH)} · ${STRINGS.planner.statusEarth(v.earth, v.gapH)}` : undefined}
              style={{ left: `${fx * 100}%`, top: `${fy * 100}%` }}
              onClick={() => onSelect(site.id)}
            >
              <span className="moon-pin-dot" aria-hidden="true" />
              {/* B2: the Earth beside the Sun-shaped dot: filled = all stay, half = gaps, ring = never in view */}
              {v && <span className="verdict-mark moon-pin-earth" data-body="earth" data-state={v.earth === "all" ? "full" : v.earth === "gaps" ? "half" : "empty"} aria-hidden="true" />}
              <span className="moon-pin-label">{site.name}</span>
            </button>
          );
        })}
      </div>
      <figcaption className="moon-map-caption">{failed ? STRINGS.planner.mapError : header ? STRINGS.planner.mapCaption(widthKm) : STRINGS.loading}</figcaption>
    </figure>
  );
}
