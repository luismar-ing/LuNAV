import { useEffect, useState } from "react";
import type { IlluminationHeader } from "../lib/data";
import { fractionToLatLon, mapFraction, polarXY } from "../lib/moonMap";
import { STRINGS } from "../lib/strings";
import { useApp } from "../store/appStore";

const C = STRINGS.custom;
const KM = 1000;

/**
 * B12: pick a custom coordinate on the map of the south pole (the LOLA average sunlight of the Moon map, 85°S to
 * the pole). A click sets the point; with the keyboard, the arrow keys move the marker 1 km (Shift: 5 km) on the
 * map, so the picker is not pointer-only. The five candidate sites are drawn as small rings for reference.
 */
export function PointPicker({ lat, lon, limitDeg, onPick }: { lat: number | null; lon: number | null; limitDeg: number; onPick(lat: number, lon: number): void }) {
  const data = useApp((s) => s.data);
  const sites = useApp((s) => s.sites);
  const [header, setHeader] = useState<IlluminationHeader | null>(null);
  const [hover, setHover] = useState<{ lat: number; lon: number } | null>(null);

  useEffect(() => {
    let alive = true;
    data
      .illumination()
      .then((h) => alive && setHeader(h))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [data]);
  if (!header) return null;

  const ext = header.extent_m;
  const at = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const p = fractionToLatLon(ext, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    return p.lat <= limitDeg ? p : null;
  };
  const move = (dxKm: number, dyKm: number) => {
    if (lat === null || lon === null) return;
    const [x, y] = polarXY(lat, lon);
    const fx = (x + dxKm * KM - ext.left) / (ext.right - ext.left);
    const fy = (ext.top - (y + dyKm * KM)) / (ext.top - ext.bottom);
    const p = fractionToLatLon(ext, fx, fy);
    if (p.lat <= limitDeg) onPick(p.lat, p.lon);
  };
  const marker = lat !== null && lon !== null ? mapFraction(ext, lat, lon) : null;
  const fmt = (v: number) => v.toFixed(3);

  return (
    <figure className="point-picker" data-testid="point-picker">
      <div
        className="point-picker-disc"
        role="application"
        tabIndex={0}
        aria-label={C.pickerAria}
        aria-describedby="point-picker-readout"
        onClick={(e) => {
          const p = at(e);
          if (p) onPick(p.lat, p.lon);
        }}
        onMouseMove={(e) => setHover(at(e))}
        onMouseLeave={() => setHover(null)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 5 : 1;
          const d: Record<string, [number, number]> = { ArrowUp: [0, step], ArrowDown: [0, -step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] };
          if (!d[e.key]) return;
          e.preventDefault();
          move(...d[e.key]);
        }}
      >
        <img src={data.illuminationImageUrl()} alt="" draggable={false} />
        {sites.map((s) => {
          const f = mapFraction(ext, s.lat, s.lon);
          return <span key={s.id} className="point-picker-site" title={s.name} style={{ left: `${f.fx * 100}%`, top: `${f.fy * 100}%` }} aria-hidden="true" />;
        })}
        {marker && (
          <span className="point-picker-marker" data-testid="point-picker-marker" style={{ left: `${marker.fx * 100}%`, top: `${marker.fy * 100}%` }} aria-hidden="true" />
        )}
      </div>
      <figcaption id="point-picker-readout" className="finder-method" aria-live="off">
        {hover ? C.pickerHover(fmt(hover.lat), fmt(hover.lon)) : C.pickerIdle}
      </figcaption>
    </figure>
  );
}
