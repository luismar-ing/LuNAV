import type { EarthState, SunState } from "../lib/siteBrief";

/**
 * Two small marks for a plan (B2): the Sun (filled = no night in the stay, ring = a night) and the Earth (filled = in
 * view all stay, half = gaps, ring = never in view). Shape carries the meaning, the body colours only repeat it (spec
 * 9: never colour alone). Decorative: the text beside them says the same thing.
 */
export function VerdictMarks({ sun, earth }: { sun: SunState; earth: EarthState }) {
  return (
    <span className="verdict-marks" aria-hidden="true">
      <span className="verdict-mark" data-body="sun" data-state={sun === "lit" ? "full" : "empty"} />
      <span className="verdict-mark" data-body="earth" data-state={earth === "all" ? "full" : earth === "gaps" ? "half" : "empty"} />
    </span>
  );
}
