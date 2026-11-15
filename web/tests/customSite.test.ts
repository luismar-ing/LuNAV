/**
 * B12 (decision A13): custom coordinates. The browser computation must give the five published sites back:
 *  1. the Sun and Earth seen from each site (sky/moon_me.bin + ENU) = the pipeline's SPICE series;
 *  2. with each site's own 40 m mask, the window metrics = the published windows (same rules as the pipeline);
 *  3. with the mask of the nearest 5 km grid point instead, the difference is measured and bounded (it is what
 *     the panel states as approximate).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WindowRow } from "../src/lib/contract";
import {
  analyseCustomSite,
  latLonToPolar,
  horizonFrom,
  parseCoordinates,
  parseLevel,
  parseSky,
  polarToLatLon,
  skyFrom,
  surfaceDistanceM,
  visibility,
  windowRows,
  type CustomTerrain,
  type CustomTerrainHeader,
  type SkyHeader,
} from "../src/lib/customSite";

const DATA = join(__dirname, "..", "public", "data");
const json = <T>(p: string) => JSON.parse(readFileSync(join(DATA, p), "utf-8")) as T;
const bin = (p: string) => {
  const b = readFileSync(join(DATA, p));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const SKY = parseSky(json<SkyHeader>("sky/sky.json"), bin("sky/moon_me.bin"));
const SITES = json<{ id: string; lat: number; lon: number; elevation_m: number }[]>("sites.json");
const manifest = json<{ params: { sun_radius_deg: number; antenna_margin_deg: number; h_obs_m: number }; date_range: { arrival_start: string; arrival_end: string } }>("manifest.json");
const P = { sunRadiusDeg: manifest.params.sun_radius_deg, antennaMarginDeg: manifest.params.antenna_margin_deg };
const N_ARRIVALS = Math.round((Date.parse(manifest.date_range.arrival_end) - Date.parse(manifest.date_range.arrival_start)) / 86_400_000) + 1;
const HAS_TERRAIN = existsSync(join(DATA, "terrain_custom", "terrain.json"));
const loadTerrain = (): CustomTerrain => {
  const header = json<CustomTerrainHeader>("terrain_custom/terrain.json");
  return {
    header,
    fine: parseLevel(header.fine, bin(`terrain_custom/${header.fine.bin_file}`), header.height_scale_m),
    coarse: parseLevel(header.coarse, bin(`terrain_custom/${header.coarse.bin_file}`), header.height_scale_m),
  };
};

describe("coordinates", () => {
  it("polar stereographic round trip; 85°S is 151.7 km from the pole", () => {
    const [x, y] = latLonToPolar(-85, 0);
    expect(Math.hypot(x, y)).toBeCloseTo(151_713, 0);
    for (const [lat, lon] of [[-89.43904, -137.09641], [-86.8, 17.2], [-88, 120]]) {
      const [la, lo] = polarToLatLon(...latLonToPolar(lat, lon));
      expect(la).toBeCloseTo(lat, 9);
      expect(lo).toBeCloseTo(lon, 9);
    }
    expect(surfaceDistanceM(-90, 0, -89, 0)).toBeCloseTo((Math.PI / 180) * 1_737_400, 3);
  });

  it("parses the usual ways of writing a coordinate", () => {
    expect(parseCoordinates("-89.44, -137.1")).toEqual({ lat: -89.44, lon: -137.1 });
    expect(parseCoordinates("89.44S 137.1W")).toEqual({ lat: -89.44, lon: -137.1 });
    expect(parseCoordinates("89.44°S, 222.9°E")).toEqual({ lat: -89.44, lon: -137.1 });
    expect(parseCoordinates("-87.5 ; 45")).toEqual({ lat: -87.5, lon: 45 });
    expect(parseCoordinates("hello")).toBeNull();
    expect(parseCoordinates("-95, 0")).toBeNull();
  });
});

describe("the sky from any point = the pipeline's SPICE series at the five sites", () => {
  for (const s of SITES) {
    it(s.id, () => {
      const ts = json<{ n: number; angle_scale: number; sun_az: number[]; sun_el: number[]; earth_az: number[]; earth_el: number[] }>(`timeseries/${s.id}.json`);
      const sky = skyFrom(SKY, s.lat, s.lon, s.elevation_m, manifest.params.h_obs_m);
      expect(sky.n).toBe(ts.n);
      let worst = 0;
      const dAz = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
      for (let k = 0; k < ts.n; k++) {
        worst = Math.max(
          worst,
          Math.abs(sky.sunEl[k] - ts.sun_el[k] * ts.angle_scale),
          Math.abs(sky.earthEl[k] - ts.earth_el[k] * ts.angle_scale),
          dAz(sky.sunAz[k], ts.sun_az[k] * ts.angle_scale) * Math.cos((sky.sunEl[k] * Math.PI) / 180),
          dAz(sky.earthAz[k], ts.earth_az[k] * ts.angle_scale),
        );
      }
      console.log(`sky ${s.id}: worst |Δ| over ${ts.n} instants = ${worst.toFixed(4)}° (series stored to 0.01°)`);
      expect(worst).toBeLessThan(0.006); // the published series are rounded to 0.01°: ±0.005° plus float32
    });
  }
});

describe("window metrics with each site's own 40 m mask = the published windows", () => {
  for (const s of SITES) {
    for (const L of [3, 7, 14]) {
      it(`${s.id}, ${L} days`, () => {
        const mask = json<{ elev_deg: number[]; az_step_deg: number }>(`horizon/${s.id}.json`);
        const sky = skyFrom(SKY, s.lat, s.lon, s.elevation_m, manifest.params.h_obs_m);
        const vis = visibility(sky, mask.elev_deg, { ...P, azStepDeg: mask.az_step_deg });
        const rows = windowRows(vis.sun, vis.earth, sky.startMs, sky.stepMin, N_ARRIVALS, L);
        const pub = json<{ rows: WindowRow[] }>(`windows/${s.id}_${L}d.json`).rows;
        expect(rows).toHaveLength(pub.length);
        let worst = 0;
        let exact = 0;
        rows.forEach((r, i) => {
          expect(r.start).toBe(pub[i].start);
          const d = Math.max(
            Math.abs(r.sun_pct - pub[i].sun_pct),
            Math.abs(r.longest_dark_h - pub[i].longest_dark_h),
            Math.abs(r.earth_h_min - pub[i].earth_h_min),
            Math.abs(r.earth_h_mean - pub[i].earth_h_mean),
            Math.abs(r.longest_comm_gap_h - pub[i].longest_comm_gap_h),
          );
          worst = Math.max(worst, d);
          if (d < 0.011) exact++;
        });
        console.log(`windows ${s.id} ${L} d: ${exact}/${rows.length} arrivals identical, worst difference ${worst.toFixed(2)}`);
        // measured: every arrival identical (differences ≤ 0.01 are the last digit of the rounding). The margin
        // allows a flag to flip if the Sun or the Earth grazes the mask within the float32 rounding of the vectors
        expect(exact / rows.length).toBeGreaterThan(0.99);
        expect(worst).toBeLessThanOrEqual(0.6);
      });
    }
  }
});

describe.runIf(HAS_TERRAIN)("horizon traced from the exact coordinate over the reduced relief", () => {
  const terrain = HAS_TERRAIN ? loadTerrain() : null;
  const ref = json<Record<string, { z0_m: number; elev_deg: number[] }>>("../../tests/fixtures/custom_site_masks.json");

  it("outside 85°S there is no horizon; inside there is", () => {
    expect(horizonFrom(terrain!, -84.5, 0)).toBeNull();
    expect(horizonFrom(terrain!, -89.9, 10)).not.toBeNull();
    expect(horizonFrom(terrain!, -85.01, 123)).not.toBeNull();
  });

  for (const s of SITES) {
    it(`${s.id}: same mask as the Python reference; close to the official 40 m mask`, () => {
      const p = horizonFrom(terrain!, s.lat, s.lon)!;
      // 1. the browser traces the same rays as pipeline/custom_site.py hybrid_mask
      expect(p.elevationM).toBeCloseTo(ref[s.id].z0_m, 2);
      let refDiff = 0;
      p.mask.forEach((v, a) => (refDiff = Math.max(refDiff, Math.abs(v - ref[s.id].elev_deg[a]))));
      expect(refDiff).toBeLessThan(0.005);
      // 2. against the official 40 m mask: the cost of the reduced relief, measured over the year and per stay
      const own = json<{ elev_deg: number[] }>(`horizon/${s.id}.json`).elev_deg;
      let maskMax = 0;
      let maskMean = 0;
      own.forEach((v, a) => {
        maskMax = Math.max(maskMax, Math.abs(p.mask[a] - v));
        maskMean += Math.abs(p.mask[a] - v) / own.length;
      });
      const res = analyseCustomSite(SKY, terrain!, s.lat, s.lon, 7, N_ARRIVALS, P)!;
      const sky = skyFrom(SKY, s.lat, s.lon, s.elevation_m, manifest.params.h_obs_m);
      const official = visibility(sky, own, { ...P, azStepDeg: 1 });
      const year = 365 * 48;
      const pct = (f: Uint8Array) => (100 * f.subarray(0, year).reduce((a, b) => a + b, 0)) / year;
      const sunYear = pct(res.sun) - pct(official.sun);
      const earthYear = pct(res.earth) - pct(official.earth);
      const pub = json<{ rows: WindowRow[] }>(`windows/${s.id}_7d.json`).rows;
      const meanAbs = (k: "sun_pct" | "longest_dark_h" | "earth_h_min") => res.rows.reduce((acc, r, i) => acc + Math.abs(r[k] - pub[i][k]), 0) / pub.length;
      console.log(
        `reduced ${s.id}: ground ${p.elevationM.toFixed(0)} m vs ${s.elevation_m.toFixed(0)} m; mask max |Δ| ${maskMax.toFixed(2)}°, mean ${maskMean.toFixed(2)}°; ` +
          `year sun ${sunYear >= 0 ? "+" : ""}${sunYear.toFixed(1)} pts, Earth link ${earthYear >= 0 ? "+" : ""}${earthYear.toFixed(1)} pts; ` +
          `7 d mean |Δ| sun ${meanAbs("sun_pct").toFixed(1)} pts, longest night ${meanAbs("longest_dark_h").toFixed(1)} h, Earth worst day ${meanAbs("earth_h_min").toFixed(1)} h`,
      );
      // bounds from the measurement (docs/DECISIONS.md A13): the panel states "within 5 percentage points" for the year's sunlight
      expect(maskMean).toBeLessThan(0.35);
      expect(Math.abs(sunYear)).toBeLessThan(4.5);
      expect(Math.abs(earthYear)).toBeLessThan(3);
    });
  }
});
