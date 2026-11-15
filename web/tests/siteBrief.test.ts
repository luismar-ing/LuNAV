/** B2 (finding H6): a plan is judged on the Sun AND the Earth, from the real window rows. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Timeseries, WindowRow } from "../src/lib/contract";
import { nightInStay, overlapH, planVerdict } from "../src/lib/siteBrief";
import { STRINGS } from "../src/lib/strings";

const REAL = join(__dirname, "..", "public", "data", "windows");
const row = (site: string, day: string, L = 7): WindowRow => {
  const rows = (JSON.parse(readFileSync(join(REAL, `${site}_${L}d.json`), "utf-8")) as { rows: WindowRow[] }).rows;
  return rows.find((r) => r.start.startsWith(day))!;
};
const status = (r: WindowRow) => {
  const v = planVerdict(r);
  return `${STRINGS.planner.statusSun(v.darkH)} · ${STRINGS.planner.statusEarth(v.earth, v.gapH)}`;
};

describe("plan verdict: Sun and Earth together (B2)", () => {
  it("Connecting Ridge, Jan 1 2027: sunlit but no Earth for the whole stay is not a good plan", () => {
    const v = planVerdict(row("connecting_ridge", "2027-01-01"));
    expect(v).toMatchObject({ sun: "lit", earth: "none", tone: "poor", darkH: 0, gapH: 168 });
    expect(status(row("connecting_ridge", "2027-01-01"))).toBe("Sunlit all stay · No Earth all stay");
  });

  it("Haworth, Jan 1 2027: a short night and a 164 h Earth gap is poor", () => {
    const v = planVerdict(row("haworth", "2027-01-01"));
    expect(v).toMatchObject({ sun: "night", earth: "gaps", tone: "poor", darkH: 0.5, gapH: 164 });
    expect(status(row("haworth", "2027-01-01"))).toBe("0.5 h night in stay · Earth gap 164 h");
    expect(STRINGS.planner.verdict(v.sun, v.earth, v.darkH, v.gapH)).toBe("0.5 h of night in the stay and up to 164 h without direct Earth contact.");
  });

  it("Haworth, Jan 9 2027: sunlit with the Earth all stay is the only good tone", () => {
    expect(planVerdict(row("haworth", "2027-01-09"))).toMatchObject({ sun: "lit", earth: "all", tone: "good" });
    expect(status(row("haworth", "2027-01-09"))).toBe("Sunlit all stay · Earth all stay");
  });

  it("Haworth, Jan 11 2027: a 34 h night with the Earth all stay is mixed", () => {
    expect(planVerdict(row("haworth", "2027-01-11"))).toMatchObject({ sun: "night", earth: "all", tone: "mixed", darkH: 34 });
    expect(status(row("haworth", "2027-01-11"))).toBe("34 h night in stay · Earth all stay");
  });

  it("uses the Earth gap, not the worst day: Haworth Jan 6 has earth_h_min 0 but the Earth most of the time", () => {
    const r = row("haworth", "2027-01-06");
    expect(r.earth_h_min).toBe(0);
    expect(planVerdict(r)).toMatchObject({ sun: "night", earth: "gaps", gapH: 44 });
  });

  it("good only when both hold, over every site and day of the year (7-day stays)", () => {
    const sites = ["connecting_ridge", "haworth", "malapert_massif", "nobile_rim_1", "de_gerlache_rim_2"];
    for (const s of sites) {
      const rows = (JSON.parse(readFileSync(join(REAL, `${s}_7d.json`), "utf-8")) as { rows: WindowRow[] }).rows;
      for (const r of rows) {
        const v = planVerdict(r);
        expect(v.tone === "good").toBe(r.longest_dark_h === 0 && r.longest_comm_gap_h === 0);
        if (r.earth_h_mean === 0) expect(v.tone).toBe("poor");
      }
    }
  });
});

const SITES = ["connecting_ridge", "haworth", "malapert_massif", "nobile_rim_1", "de_gerlache_rim_2"];
const series = (site: string) => JSON.parse(readFileSync(join(REAL, "..", "timeseries", `${site}.json`), "utf-8")) as Timeseries;

describe("one night, one figure in context (B3)", () => {
  it("Haworth, Jan 11 2027 (7 d): 34 h of the 36.5 h night are inside the stay", () => {
    const n = nightInStay(series("haworth"), Date.parse("2027-01-11T00:00:00Z"), 7 * 24)!;
    expect(n).toMatchObject({ inStayH: 34, fullH: 36.5, fullKnown: true });
    expect(new Date(n.startMs).toISOString()).toBe("2027-01-16T14:00:00.000Z"); // the sunset of the countdown
    expect(overlapH(n.startMs, n.endMs, Date.parse("2027-01-11T00:00:00Z"), Date.parse("2027-01-18T00:00:00Z"))).toBe(34);
  });

  it("a stay with no night has none", () => {
    expect(nightInStay(series("haworth"), Date.parse("2027-01-09T00:00:00Z"), 7 * 24)).toBeNull();
  });

  it("parity with the pipeline: the night inside the stay is the window's longest_dark_h, every site, day and stay", () => {
    for (const site of SITES) {
      const ts = series(site);
      for (const L of [3, 7, 14]) {
        const rows = (JSON.parse(readFileSync(join(REAL, `${site}_${L}d.json`), "utf-8")) as { rows: WindowRow[] }).rows;
        for (const r of rows) {
          const n = nightInStay(ts, Date.parse(r.start), L * 24);
          expect(n?.inStayH ?? 0, `${site} ${r.start} ${L} d`).toBeCloseTo(r.longest_dark_h, 6);
          if (n) expect(n.fullH).toBeGreaterThanOrEqual(n.inStayH);
        }
      }
    }
  });
});
