/** B2 (finding H6): a plan is judged on the Sun AND the Earth, from the real window rows. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WindowRow } from "../src/lib/contract";
import { planVerdict } from "../src/lib/siteBrief";
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
    expect(status(row("haworth", "2027-01-01"))).toBe("0.5 h night · Earth gap 164 h");
    expect(STRINGS.planner.verdict(v.sun, v.earth, v.darkH, v.gapH)).toBe("A 0.5 h night and up to 164 h without direct Earth contact.");
  });

  it("Haworth, Jan 9 2027: sunlit with the Earth all stay is the only good tone", () => {
    expect(planVerdict(row("haworth", "2027-01-09"))).toMatchObject({ sun: "lit", earth: "all", tone: "good" });
    expect(status(row("haworth", "2027-01-09"))).toBe("Sunlit all stay · Earth all stay");
  });

  it("Haworth, Jan 11 2027: a 34 h night with the Earth all stay is mixed", () => {
    expect(planVerdict(row("haworth", "2027-01-11"))).toMatchObject({ sun: "night", earth: "all", tone: "mixed", darkH: 34 });
    expect(status(row("haworth", "2027-01-11"))).toBe("34 h night · Earth all stay");
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
