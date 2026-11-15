/**
 * B13 (decision A14): the ILLUSTRATIVE trajectory built in the browser (lib/trajectoryBuilder.ts, a port of
 * pipeline/trajectory.py) against the published trajectory/{id}.json of the five sites, on dates spread over the
 * year (first and last arrival included): same sample times and phases, positions within 1 km (the files are
 * rounded to 0.1 km; the hourly scene ephemeris adds metres), and the last point on the site at landing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TrajectorySchema, parseInstant, type SceneEphemeris, type Site, type Trajectory } from "../src/lib/contract";
import { buildTrajectory, observerPositionKm } from "../src/lib/trajectoryBuilder";
import { ephemerisRange, indexEphemeris, rotate, sceneStateAt } from "../src/scene3d/ephemeris";

const DATA = join(__dirname, "..", "public", "data");
const json = <T>(p: string) => JSON.parse(readFileSync(join(DATA, p), "utf-8")) as T;
const SITES = json<Site[]>("sites.json");
const IX = indexEphemeris(json<SceneEphemeris>("scene/ephemeris.json"));
const manifest = json<{ date_range: { arrival_start: string; arrival_end: string }; params: { transit_days: number; window_days: number[] } }>("manifest.json");
const DATES = ["2027-01-01", "2027-03-14", "2027-05-27", "2027-08-09", "2027-10-22", "2027-12-31"];

describe("buildTrajectory (port of pipeline/trajectory.py)", () => {
  for (const site of SITES) {
    it(`${site.id}: matches the published trajectories within 1 km`, () => {
      let worst = 0;
      for (const day of DATES) {
        const ms = Date.parse(`${day}T00:00:00Z`);
        const ours = buildTrajectory(site, ms, IX, manifest.params.transit_days);
        const pub = json<Trajectory>(`trajectory/${ours.id}.json`);
        expect(TrajectorySchema.safeParse(ours).success).toBe(true);
        expect(ours.id).toBe(pub.id);
        expect(ours.mode).toBe("ILLUSTRATIVE");
        expect(ours.phases).toEqual(pub.phases);
        expect(ours.t0_utc).toBe(pub.t0_utc);
        expect(ours.t_s.length).toBe(pub.t_s.length);
        ours.t_s.forEach((t, i) => expect(Math.abs(t - pub.t_s[i])).toBeLessThanOrEqual(0.1 + 1e-9));
        ours.pos_km.forEach((p, i) => {
          const q = pub.pos_km[i];
          worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
        });
        // the landing point is the site at landing_utc
        const s = sceneStateAt(IX, parseInstant(ours.phases.landing_utc));
        const r = rotate(s.moonQuat, observerPositionKm(site.lat, site.lon, site.elevation_m, 0));
        const last = ours.pos_km[ours.pos_km.length - 1];
        expect(Math.hypot(last[0] - s.moonKm[0] - r[0], last[1] - s.moonKm[1] - r[1], last[2] - s.moonKm[2] - r[2])).toBeLessThan(0.1);
      }
      expect(worst).toBeLessThanOrEqual(1);
    });
  }

  it("the scene ephemeris covers every journey: the earliest launch and the latest landing plus the longest stay", () => {
    const [from, to] = ephemerisRange(IX);
    const first = Date.parse(`${manifest.date_range.arrival_start}T00:00:00Z`);
    const last = Date.parse(`${manifest.date_range.arrival_end}T00:00:00Z`);
    const early = buildTrajectory({ id: "custom_test", lat: -88, lon: 45, elevation_m: 0 }, first, IX, manifest.params.transit_days);
    expect(parseInstant(early.phases.launch_utc)).toBeGreaterThanOrEqual(from);
    expect(last + Math.max(...manifest.params.window_days) * 86_400_000).toBeLessThanOrEqual(to);
  });
});
