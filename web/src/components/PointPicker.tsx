import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { IlluminationHeader } from "../lib/data";
import { lastInputWasKeyboard, restoreFocus } from "../lib/inputModality";
import { fractionToLatLon, mapFraction, polarXY } from "../lib/moonMap";
import { STRINGS } from "../lib/strings";
import { useApp } from "../store/appStore";

const C = STRINGS.custom;
const KM = 1000;
const FOCUSABLE = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';
const fmt = (v: number) => v.toFixed(3);

interface DiscProps {
  header: IlluminationHeader;
  lat: number | null;
  lon: number | null;
  limitDeg: number;
  onPick(lat: number, lon: number): void;
  onHover(p: { lat: number; lon: number } | null): void;
  readoutId: string;
  large?: boolean;
}

/**
 * The map of the south pole (LOLA average sunlight, 85°S to the pole) as a picker: a click sets the point; the arrow
 * keys move the marker 1 km (Shift: 5 km), so it does not need a pointer. The five candidate sites are drawn as rings.
 */
function PickerDisc({ header, lat, lon, limitDeg, onPick, onHover, readoutId, large }: DiscProps) {
  const data = useApp((s) => s.data);
  const sites = useApp((s) => s.sites);
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
    const p = fractionToLatLon(ext, (x + dxKm * KM - ext.left) / (ext.right - ext.left), (ext.top - (y + dyKm * KM)) / (ext.top - ext.bottom));
    if (p.lat <= limitDeg) onPick(p.lat, p.lon);
  };
  const marker = lat !== null && lon !== null ? mapFraction(ext, lat, lon) : null;

  return (
    <div
      className="point-picker-disc"
      data-large={large || undefined}
      role="application"
      tabIndex={0}
      aria-label={C.pickerAria}
      aria-describedby={readoutId}
      onClick={(e) => {
        const p = at(e);
        if (p) onPick(p.lat, p.lon);
      }}
      onMouseMove={(e) => onHover(at(e))}
      onMouseLeave={() => onHover(null)}
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
        return (
          <span key={s.id} className="point-picker-site" title={s.name} style={{ left: `${f.fx * 100}%`, top: `${f.fy * 100}%` }} aria-hidden="true">
            {large && <span className="point-picker-site-label">{s.name.replace(/ \(.*\)$/, "")}</span>}
          </span>
        );
      })}
      {marker && (
        <span className="point-picker-marker" data-testid={large ? "point-picker-marker-large" : "point-picker-marker"} style={{ left: `${marker.fx * 100}%`, top: `${marker.fy * 100}%` }} aria-hidden="true" />
      )}
    </div>
  );
}

/**
 * The large map in a modal dialog over the panel (B12c): the same picker at up to the height of the screen, with the
 * site names. Each click or arrow key updates the point and its analysis behind; "Done", Esc or the backdrop close it
 * and the focus returns to the "Enlarge map" button. Rendered in document.body so no transformed ancestor clips it;
 * its key events stop here so the drawer behind does not also handle them.
 */
function PickerModal({ header, lat, lon, limitDeg, onPick, onClose }: Omit<DiscProps, "onHover" | "readoutId"> & { onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ lat: number; lon: number } | null>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const byPointer = !lastInputWasKeyboard();
    ref.current?.querySelector<HTMLElement>(".point-picker-disc")?.focus();
    return () => restoreFocus(opener, byPointer);
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="picker-modal-backdrop" onClick={onClose} data-testid="picker-modal-backdrop">
      <div
        ref={ref}
        className="picker-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="picker-modal-title"
        data-testid="picker-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="picker-modal-head">
          <h2 id="picker-modal-title" className="drawer-title">
            {C.mapTitle}
          </h2>
          <button type="button" className="btn primary" onClick={onClose}>
            {C.mapDone}
          </button>
        </div>
        <PickerDisc header={header} lat={lat} lon={lon} limitDeg={limitDeg} onPick={onPick} onHover={setHover} readoutId="picker-modal-readout" large />
        <p id="picker-modal-readout" className="finder-method picker-modal-readout">
          {hover ? C.pickerHover(fmt(hover.lat), fmt(hover.lon)) : lat !== null && lon !== null ? C.pickerChosen(fmt(lat), fmt(lon)) : C.pickerIdle}
          {" · "}
          {C.mapCaption}
        </p>
      </div>
    </div>,
    document.body,
  );
}

/**
 * B12: pick a custom coordinate on the map of the south pole, small in the panel, or large in a modal ("Enlarge map").
 */
export function PointPicker({ lat, lon, limitDeg, onPick }: { lat: number | null; lon: number | null; limitDeg: number; onPick(lat: number, lon: number): void }) {
  const data = useApp((s) => s.data);
  const [header, setHeader] = useState<IlluminationHeader | null>(null);
  const [hover, setHover] = useState<{ lat: number; lon: number } | null>(null);
  const [large, setLarge] = useState(false);

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

  return (
    <figure className="point-picker" data-testid="point-picker">
      <PickerDisc header={header} lat={lat} lon={lon} limitDeg={limitDeg} onPick={onPick} onHover={setHover} readoutId="point-picker-readout" />
      <figcaption id="point-picker-readout" className="finder-method">
        {hover ? C.pickerHover(fmt(hover.lat), fmt(hover.lon)) : C.pickerIdle}
      </figcaption>
      <button type="button" className="btn ghost" onClick={() => setLarge(true)} aria-haspopup="dialog">
        {C.mapEnlarge}
      </button>
      {large && <PickerModal header={header} lat={lat} lon={lon} limitDeg={limitDeg} onPick={onPick} onClose={() => setLarge(false)} />}
    </figure>
  );
}
