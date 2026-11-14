/** Planner redesign: the Moon map's projection, distances, countdowns and the plain-language site brief. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Site, Timeseries } from "../src/lib/contract";
import { distanceKm, fmtDuration, fmtUtc, mapFraction, nextChange, polarXY, sampleIndex } from "../src/lib/moonMap";
import { readAt, upcoming, visibleSpans } from "../src/lib/siteBrief";
import { polarToLonLat } from "../src/scene3d/terrain";

const DATA = join(__dirname, "..", "public", "data");
const json = <T>(p: string): T => JSON.parse(readFileSync(join(DATA, p), "utf8")) as T;
const sites = json<Site[]>("sites.json");
const site = (id: string) => sites.find((s) => s.id === id) as Site;
const ext = json<{ extent_m: { left: number; right: number; bottom: number; top: number } }>("illumination/south_avg.json").extent_m;

describe("Moon map geometry", () => {
  it("polarXY is the inverse of the 3D terrain's polarToLonLat", () => {
    for (const s of sites) {
      const [x, y] = polarXY(s.lat, s.lon);
      const [lon, lat] = polarToLonLat(x, y);
      expect(lat).toBeCloseTo(s.lat, 6);
      expect(lon).toBeCloseTo(s.lon, 6);
    }
  });

  it("places the sites where pyproj puts them on the map (percent of width and height)", () => {
    // reference: pyproj with the map's own projection string (south_avg.json), 2026-11-14
    const ref: Record<string, [number, number]> = {
      connecting_ridge: [46.18, 54.11],
      haworth: [35.68, 16.59],
      nobile_rim_1: [78.41, 11.73],
      malapert_massif: [51.44, 9.92],
      de_gerlache_rim_2: [36.92, 44.69],
    };
    for (const [id, [px, py]] of Object.entries(ref)) {
      const { fx, fy } = mapFraction(ext, site(id).lat, site(id).lon);
      expect(fx * 100).toBeCloseTo(px, 1);
      expect(fy * 100).toBeCloseTo(py, 1);
    }
  });

  it("great-circle distances between sites", () => {
    expect(distanceKm(site("connecting_ridge"), site("de_gerlache_rim_2"))).toBeCloseTo(40, 0);
    expect(distanceKm(site("haworth"), site("malapert_massif"))).toBeCloseTo(52, 0);
    expect(distanceKm(site("haworth"), site("haworth"))).toBe(0);
  });

  it("formats", () => {
    expect(fmtDuration(134)).toBe("5 d 14 h");
    expect(fmtDuration(18.5)).toBe("18 h 30 m");
    expect(fmtDuration(2)).toBe("2 h");
    expect(fmtUtc(Date.parse("2027-01-16T14:00:00Z"))).toBe("16 Jan, 14:00 UTC");
  });
});

describe("countdowns from the visibility series", () => {
  const ts = json<Timeseries>("timeseries/haworth.json");
  const jan11 = Date.parse("2027-01-11T00:00:00Z");

  it("nextChange counts to the next change and how long the other state lasts", () => {
    expect(nextChange([1, 1, 0, 0, 0, 1], 0, 30)).toEqual({ visible: true, hours: 1, lastsH: 1.5 });
    expect(nextChange([0, 1, 1], 0, 30)).toEqual({ visible: false, hours: 0.5, lastsH: null });
    expect(nextChange([1, 1], 0, 30)).toEqual({ visible: true, hours: null, lastsH: null });
    expect(nextChange([1], 3, 30)).toBeNull();
  });

  it("Haworth, landing 11 Jan 2027: sunset after 5 d 14 h, 36.5 h of night, Earth sets after the stay", () => {
    const r = readAt(ts, jan11);
    expect(r.k).toBe(sampleIndex(ts, jan11));
    expect(r.sun).toEqual({ visible: true, hours: 134, lastsH: 36.5 });
    expect(r.earth?.visible).toBe(true);
    expect(r.earth?.hours).toBe(380.5);
  });

  it("the Sun track over the stay and what happens next", () => {
    const k = sampleIndex(ts, jan11);
    const spans = visibleSpans(ts.sun_vis, k, 336);
    expect(spans).toEqual([{ from: 0, to: 268 / 336 }]); // lit 134 h of 168
    const now = jan11 + 48 * 3_600_000; // day 3
    const end = jan11 + 168 * 3_600_000;
    const ev = upcoming(ts, now, end);
    expect(ev.map((e) => e.kind)).toEqual(["sunset", "end", "sunrise", "earthset"]);
    expect(fmtUtc(ev[0].atMs)).toBe("16 Jan, 14:00 UTC");
    expect(ev[1].inDark).toBe(true);
    expect(ev[2].afterStay).toBe(true);
    expect(fmtUtc(ev[3].atMs)).toBe("26 Jan, 20:30 UTC");
  });
});
