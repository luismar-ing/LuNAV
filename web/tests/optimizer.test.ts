/** B11 (decision A12): the best-plan search is exact. Checked against brute force over the real window rows. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildWindowIndex, meetsConstraints, type WindowIndex } from "../src/lib/constraints";
import type { WindowRow } from "../src/lib/contract";
import { compareRows, countValid, planIdOf, relaxations, search, type FinderQuery } from "../src/lib/optimizer";
import type { Constraints } from "../src/store/appStore";

const DATA = join(__dirname, "..", "public", "data");
const SITES = (JSON.parse(readFileSync(join(DATA, "sites.json"), "utf-8")) as { id: string }[]).map((s) => s.id);
const PLAN_IDS = new Set((JSON.parse(readFileSync(join(DATA, "plans.json"), "utf-8")) as { id: string }[]).map((p) => p.id));
const indexOf = (L: number): WindowIndex => {
  const rows = Object.fromEntries(SITES.map((s) => [s, (JSON.parse(readFileSync(join(DATA, "windows", `${s}_${L}d.json`), "utf-8")) as { rows: WindowRow[] }).rows]));
  return buildWindowIndex(L, rows, SITES);
};
const INDEX = { 3: indexOf(3), 7: indexOf(7), 14: indexOf(14) } as Record<number, WindowIndex>;

const NONE: Constraints = { minSunPct: null, maxDarkH: null, minEarthH: null };
const q = (c: Partial<Constraints> = {}, extra: Partial<FinderQuery> = {}): FinderQuery => ({ constraints: { ...NONE, ...c }, from: null, to: null, order: "best", ...extra });
const day = (r: WindowRow) => r.start.slice(0, 10);

const CASES: Partial<Constraints>[] = [
  {},
  { minSunPct: 90 },
  { maxDarkH: 12 },
  { minEarthH: 12 },
  { minSunPct: 80, maxDarkH: 24, minEarthH: 8 },
  { minSunPct: 95, maxDarkH: 0, minEarthH: 20 },
];

describe("search: exact against brute force", () => {
  for (const L of [3, 7, 14]) {
    for (const c of CASES) {
      it(`${L} d, ${JSON.stringify(c)}`, () => {
        const index = INDEX[L];
        const res = search(index, q(c));
        // brute force: every plan, every site
        let valid = 0;
        for (const s of SITES) {
          const ok = index.rows[s].filter((r) => meetsConstraints(r, { ...NONE, ...c }));
          valid += ok.length;
          const got = res.bySite.find((r) => r.siteId === s);
          if (!ok.length) {
            expect(got).toBeUndefined();
            continue;
          }
          const best = [...ok].sort(compareRows)[0];
          expect(got?.row).toEqual(best);
          expect(got?.validDays).toBe(ok.length);
          expect(PLAN_IDS.has(got!.planId)).toBe(true);
        }
        expect(res.valid).toBe(valid);
        expect(res.evaluated).toBe(SITES.length * index.nDays);
        expect(countValid(index, q(c))).toBe(valid);
        // sites in order, best first
        for (let i = 1; i < res.bySite.length; i++) expect(compareRows(res.bySite[i - 1].row, res.bySite[i].row)).toBeLessThanOrEqual(0);
      });
    }
  }
});

describe("search: details", () => {
  it("one result per site at most, and the top one is the best plan overall", () => {
    const res = search(INDEX[7], q({ minSunPct: 80 }));
    expect(new Set(res.bySite.map((r) => r.siteId)).size).toBe(res.bySite.length);
    const all = SITES.flatMap((s) => INDEX[7].rows[s].filter((r) => r.sun_pct >= 80));
    expect(res.bySite[0].row).toEqual([...all].sort(compareRows)[0]);
  });

  it("the run holds the chosen day and every day of it meets the limits", () => {
    const c = { minSunPct: 85, maxDarkH: 12 };
    for (const r of search(INDEX[7], q(c)).bySite) {
      expect(r.run.from <= r.arrival && r.arrival <= r.run.to).toBe(true);
      const days = INDEX[7].rows[r.siteId].filter((row) => day(row) >= r.run.from && day(row) <= r.run.to);
      expect(days).toHaveLength(r.run.days);
      expect(days.every((row) => meetsConstraints(row, { ...NONE, ...c }))).toBe(true);
    }
  });

  it("is deterministic (ties at score 1.00 broken the same way)", () => {
    const a = search(INDEX[14], q());
    const b = search(INDEX[14], q());
    expect(a).toEqual(b);
  });

  it("earliest: the first arrival that meets the limits, earliest site first", () => {
    const c = { maxDarkH: 0 };
    const res = search(INDEX[7], q(c, { order: "earliest" }));
    for (const r of res.bySite) {
      const first = INDEX[7].rows[r.siteId].find((row) => meetsConstraints(row, { ...NONE, ...c }))!;
      expect(r.arrival).toBe(day(first));
    }
    for (let i = 1; i < res.bySite.length; i++) expect(res.bySite[i - 1].arrival <= res.bySite[i].arrival).toBe(true);
  });

  it("the arrival range limits the search", () => {
    const res = search(INDEX[7], q({}, { from: "2027-03-01", to: "2027-03-31" }));
    expect(res.evaluated).toBe(SITES.length * 31);
    for (const r of res.bySite) expect(r.arrival >= "2027-03-01" && r.arrival <= "2027-03-31").toBe(true);
  });

  it("Haworth, 7 days: Jan 10 has no night over 24 h, Jan 11 has a 34 h one (PROGRESS.md, B7)", () => {
    const res = search(INDEX[7], q({ maxDarkH: 24 }, { from: "2027-01-10", to: "2027-01-11" }));
    const h = res.bySite.find((r) => r.siteId === "haworth")!;
    expect(h.arrival).toBe("2027-01-10");
    expect(h.validDays).toBe(1);
  });

  it("planIdOf matches plans.json", () => {
    expect(PLAN_IDS.has(planIdOf("haworth", "2027-01-10", 7))).toBe(true);
  });
});

describe("relaxations", () => {
  it("nothing meets impossible limits; applying a suggestion gives at least one plan", () => {
    // tight limits that no site meets over every month of 14-day stays
    const c = { minSunPct: 99, maxDarkH: 0, minEarthH: 23 };
    const index = INDEX[14];
    let checked = 0;
    for (let m = 1; m <= 12; m++) {
      const range = { from: `2027-${String(m).padStart(2, "0")}-01`, to: `2027-${String(m).padStart(2, "0")}-28` };
      if (search(index, q(c, range)).valid > 0) continue;
      checked++;
      const rel = relaxations(index, q(c, range));
      expect(rel.map((r) => r.key).sort()).toEqual(["maxDarkH", "minEarthH", "minSunPct"]);
      for (const r of rel) {
        if (r.suggested === null) continue;
        expect(search(index, q({ ...c, [r.key]: r.suggested }, range)).valid).toBeGreaterThan(0);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("reports null when the other limits alone already leave nothing", () => {
    const rel = relaxations(INDEX[7], q({ minSunPct: 100, maxDarkH: 0 }, { from: "2027-01-01", to: "2027-01-01" }));
    for (const r of rel) {
      const others = { ...NONE, minSunPct: 100, maxDarkH: 0, [r.key]: null };
      const any = SITES.some((s) => meetsConstraints(INDEX[7].rows[s][0], others));
      expect(r.reachable === null).toBe(!any);
    }
  });

  it("only active limits are listed", () => {
    expect(relaxations(INDEX[7], q({ minSunPct: 99 })).map((r) => r.key)).toEqual(["minSunPct"]);
  });
});
