/** C3: the Educator's challenge scores a plan exactly like the planner, from the real series. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate, LEVEL_1, monthDays, monthOutcomes, stayTrace, traceAt } from "../src/lib/challenge";
import type { Timeseries, WindowRow } from "../src/lib/contract";
import { stayBattery } from "../src/lib/siteBrief";

const DATA = join(__dirname, "..", "public", "data");
const SITES = ["connecting_ridge", "haworth", "nobile_rim_1", "malapert_massif", "de_gerlache_rim_2"];
const series = (site: string) => JSON.parse(readFileSync(join(DATA, "timeseries", `${site}.json`), "utf-8")) as Timeseries;
const rows = (site: string, L: number) =>
  (JSON.parse(readFileSync(join(DATA, "windows", `${site}_${L}d.json`), "utf-8")) as { rows: WindowRow[] }).rows;

describe("challenge level 1", () => {
  it("is a week in March 2027: 31 arrival days", () => {
    expect(LEVEL_1).toMatchObject({ month: "2027-03", stayDays: 7 });
    const days = monthDays(LEVEL_1);
    expect(days).toHaveLength(31);
    expect(days[0]).toBe("2027-03-01");
    expect(days[30]).toBe("2027-03-31");
  });

  it("about half of the blind picks survive: 23, 9, 12, 12 and 20 of 31 days, site by site", () => {
    const wins = SITES.map((s) => Object.values(monthOutcomes(series(s), LEVEL_1)).filter(Boolean).length);
    expect(wins).toEqual([23, 9, 12, 12, 20]);
  });
});

describe("challenge result", () => {
  const haworth = series("haworth");

  it("Haworth, Jan 10 2027 (7 d): the lander survives, battery never below 50%", () => {
    const r = evaluate(haworth, "2027-01-10", 7)!;
    expect(r.success).toBe(true);
    expect(r.emptyH).toBe(0);
    expect(Math.round(r.minSoc * 100)).toBe(50);
    expect(r.batteryH).toBe(20);
  });

  it("Haworth, Jan 11 2027 (7 d): out of power for 14.5 h; 34 h of a 36.5 h night from day 6", () => {
    const r = evaluate(haworth, "2027-01-11", 7)!;
    expect(r.success).toBe(false);
    expect(r.emptyH).toBe(14.5);
    expect(r.night).toEqual({ inStayH: 34, fullH: 36.5, startDay: 6, beforeLanding: false });
  });

  it("Nobile Rim 1, Mar 2 2027 (7 d): landing in a 235.5 h night that covers the whole stay counts from day 1", () => {
    const r = evaluate(series("nobile_rim_1"), "2027-03-02", 7)!;
    expect(r.success).toBe(false);
    expect(r.sunPct).toBe(0);
    expect(r.night).toEqual({ inStayH: 168, fullH: 235.5, startDay: 1, beforeLanding: true });
  });

  it("outside the data there is no result", () => {
    expect(evaluate(haworth, "2029-01-01", 7)).toBeNull();
  });

  it("parity with the planner: same battery, same night and same sunlight, every site and March arrival", () => {
    for (const site of SITES) {
      const ts = series(site);
      const win = rows(site, 7);
      for (const day of monthDays(LEVEL_1)) {
        const r = evaluate(ts, day, 7)!;
        const b = stayBattery(ts, Date.parse(`${day}T00:00:00Z`), 7)!;
        const w = win.find((x) => x.start.startsWith(day))!;
        expect(r.emptyH, `${site} ${day}`).toBe(b.emptyH);
        expect(r.minSoc).toBe(b.minSoc);
        expect(r.night?.inStayH ?? 0).toBeCloseTo(w.longest_dark_h, 6);
        expect(r.sunPct).toBeCloseTo(w.sun_pct, 1);
      }
    }
  });
});

describe("the stay, sample by sample (played in the 3D scene)", () => {
  const at = (iso: string) => Date.parse(iso);

  it("Haworth, Jan 11 2027: the battery runs empty 20 h into the night that begins on day 6", () => {
    const tr = stayTrace(series("haworth"), "2027-01-11", 7)!;
    expect(tr.powerLostMs).toBe(at("2027-01-17T10:00:00Z"));
    expect(tr.soc).toHaveLength(7 * 48);
    expect(traceAt(tr, at("2027-01-11T00:00:00Z")).soc).toBe(1);
    expect(traceAt(tr, at("2027-01-17T10:00:00Z")).soc).toBe(0);
    expect(traceAt(tr, at("2027-01-17T09:00:00Z")).soc).toBeGreaterThan(0);
    expect(traceAt(tr, at("2027-01-17T10:00:00Z")).sun).toBe(false);
  });

  it("Nobile Rim 1, Mar 2 2027: landing in the dark, the battery lasts 20 h", () => {
    expect(stayTrace(series("nobile_rim_1"), "2027-03-02", 7)!.powerLostMs).toBe(at("2027-03-02T20:00:00Z"));
  });

  it("a lander that survives never loses power; the trace agrees with the result for every March day", () => {
    expect(stayTrace(series("haworth"), "2027-01-10", 7)!.powerLostMs).toBeNull();
    for (const site of SITES) {
      const ts = series(site);
      for (const day of monthDays(LEVEL_1)) {
        expect(stayTrace(ts, day, 7)!.powerLostMs === null).toBe(evaluate(ts, day, 7)!.success);
      }
    }
    expect(stayTrace(series("haworth"), "2029-01-01", 7)).toBeNull();
  });
});
