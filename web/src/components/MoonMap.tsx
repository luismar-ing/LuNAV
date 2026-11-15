import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Site } from "../lib/contract";
import type { IlluminationHeader } from "../lib/data";
import { distanceKm, fractionToLatLon, mapFraction, placeLabels, type Box, type LabelSide } from "../lib/moonMap";
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
export function MoonMap({
  sites,
  selectedId,
  tone,
  onSelect,
  onPickPoint,
}: {
  sites: Site[];
  selectedId: string;
  tone(id: string): SiteTone;
  onSelect(id: string): void;
  /** B12: a click on the map away from the pins: that point, south of 85°S (the keyboard path is the sidebar link). */
  onPickPoint?(lat: number, lon: number): void;
}) {
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

  // B9 (H15): each pin label goes to the side where it hits no other label, the distance tag or a dot
  const discRef = useRef<HTMLDivElement>(null);
  const kmRef = useRef<HTMLSpanElement>(null);
  const labelRefs = useRef(new Map<string, HTMLSpanElement>());
  const [size, setSize] = useState(0);
  const [sides, setSides] = useState<Record<string, LabelSide>>({});
  useEffect(() => {
    const el = discRef.current;
    if (!el) return;
    const read = () => setSize(el.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!size || !pins.length) return;
    const at = (fx: number, fy: number) => ({ cx: fx * size, cy: fy * size });
    const dots: Box[] = pins.map((p) => {
      const { cx, cy } = at(p.fx, p.fy);
      const r = p.site.id === selectedId ? 12 : 8; // dot and its Earth mark
      return { x: cx - r, y: cy - r - 6, w: 2 * r + 6, h: 2 * r + 6 };
    });
    const km = kmRef.current;
    const tag: Box[] =
      km && selected && nearest
        ? [{ x: ((selected.fx + nearest.p.fx) / 2) * size - km.offsetWidth / 2, y: ((selected.fy + nearest.p.fy) / 2) * size - km.offsetHeight / 2, w: km.offsetWidth, h: km.offsetHeight }]
        : [];
    const order = [...pins].sort((a, b) => Number(b.site.id === selectedId) - Number(a.site.id === selectedId));
    const labels = order.map((p) => {
      const el = labelRefs.current.get(p.site.id);
      return { id: p.site.id, ...at(p.fx, p.fy), w: el?.offsetWidth ?? 0, h: el?.offsetHeight ?? 0 };
    });
    const next = placeLabels(labels, [...tag, ...dots], { x: -24, y: -24, w: size + 48, h: size + 48 });
    setSides((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [size, pins, selectedId, selected, nearest]);

  return (
    <figure className="moon-map" aria-label={STRINGS.planner.map} data-testid="moon-map">
      <div
        className="moon-map-disc"
        ref={discRef}
        data-pickable={onPickPoint ? true : undefined}
        onClick={(e) => {
          if (!onPickPoint || !header || (e.target as HTMLElement).closest(".moon-pin, .moon-map-km")) return;
          const r = e.currentTarget.getBoundingClientRect();
          if (!r.width) return;
          const p = fractionToLatLon(header.extent_m, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
          if (p.lat <= -85) onPickPoint(p.lat, p.lon);
        }}
      >
        <img src={data.illuminationImageUrl()} alt="" draggable={false} />
        {selected && nearest && (
          <>
            <svg className="moon-map-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <line x1={selected.fx * 100} y1={selected.fy * 100} x2={nearest.p.fx * 100} y2={nearest.p.fy * 100} vectorEffect="non-scaling-stroke" />
            </svg>
            <span
              ref={kmRef}
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
              <span
                className="moon-pin-label"
                data-side={sides[site.id] ?? "right"}
                ref={(el) => {
                  if (el) labelRefs.current.set(site.id, el);
                  else labelRefs.current.delete(site.id);
                }}
              >
                {site.name}
              </span>
            </button>
          );
        })}
      </div>
      <figcaption className="moon-map-caption">
        {failed ? STRINGS.planner.mapError : header ? STRINGS.planner.mapCaption(widthKm) : STRINGS.loading}
        {header && onPickPoint && ` ${STRINGS.planner.mapPickHint}`}
      </figcaption>
    </figure>
  );
}
