/**
 * B13 (decision A14): the virtual site of a custom coordinate. The files built in the browser must give the five
 * candidate sites back when fed each site's own 40 m mask (daily, timeseries and score parity with the published
 * files), the reduced-relief terrain is measured against a site's published lod0, every file passes the contract
 * schemas through the DataStore, and the scene's Sun and Earth agree with the 2D sky at a custom point.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Daily, Horizon, SceneEphemeris, Site, Timeseries, Windows } from "../src/lib/contract";
import { PlansSchema, TerrainHeaderSchema } from "../src/lib/contract";
import { parseLevel, parseSky, skyFrom, visibility, type CustomTerrain, type CustomTerrainHeader, type SkyHeader } from "../src/lib/customSite";
import { DataStore } from "../src/lib/data";
import { createVirtualSite, customSiteId, dailyRows, scoreRow, scoreScale, terrainLevel, toTimeseries, virtualPlans } from "../src/lib/virtualSite";
import { indexEphemeris, rotate, sceneStateAt } from "../src/scene3d/ephemeris";
import { createAppStore } from "../src/store/appStore";

const DATA = join(__dirname, "..", "public", "data");
const json = <T>(p: string) => JSON.parse(readFileSync(join(DATA, p), "utf-8")) as T;
const bin = (p: string) => {
  const b = readFileSync(join(DATA, p));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const SKY = parseSky(json<SkyHeader>("sky/sky.json"), bin("sky/moon_me.bin"));
const SITES = json<Site[]>("sites.json");
const manifest = json<{
  sites: string[];
  date_range: { arrival_start: string; arrival_end: string };
  params: { sun_radius_deg: number; antenna_margin_deg: number; window_days: number[]; transit_days: number; score_weights: { w1: number; w2: number; w3: number } };
}>("manifest.json");
const VIS = { sunRadiusDeg: manifest.params.sun_radius_deg, antennaMarginDeg: manifest.params.antenna_margin_deg, azStepDeg: 1 };
const HAS_TERRAIN = existsSync(join(DATA, "terrain_custom", "terrain.json"));
const fileStore = () =>
  new DataStore("/data/", async (url) => {
    try {
      return new Response(readFileSync(join(DATA, url.replace(/^\/data\//, ""))), { status: 200 });
    } catch {
      return new Response("", { status: 404 });
    }
  });

/** A real site seen through the virtual-site code, with its own 40 m mask. */
function asVirtual(s: Site) {
  const mask = json<Horizon>(`horizon/${s.id}.json`).elev_deg;
  const series = skyFrom(SKY, s.lat, s.lon, s.elevation_m, 3);
  return { series, ...visibility(series, mask, VIS) };
}

describe("virtual site files = the published ones at the five sites (40 m mask)", () => {
  for (const s of SITES) {
    it(`${s.id}: daily and timeseries`, () => {
      const v = asVirtual(s);
      const pubDaily = json<Daily>(`daily/${s.id}.json`).days;
      const days = dailyRows(v.series.startMs, v.series.stepMin, v.sun, v.earth);
      expect(days).toHaveLength(pubDaily.length);
      let exact = 0;
      days.forEach((d, i) => {
        expect(d.date).toBe(pubDaily[i].date);
        if (JSON.stringify(d) === JSON.stringify(pubDaily[i])) exact++;
      });
      // the same rules; a flag can flip where the Sun's limb or the Earth grazes the horizon (float32 vectors)
      expect(exact / days.length).toBeGreaterThan(0.97);

      const ts = toTimeseries(s.id, v.series, v.sun, v.earth);
      const pub = json<Timeseries>(`timeseries/${s.id}.json`);
      expect([ts.start_utc, ts.step_min, ts.n, ts.angle_scale]).toEqual([pub.start_utc, pub.step_min, pub.n, pub.angle_scale]);
      let worst = 0;
      for (let k = 0; k < ts.n; k += 7) {
        worst = Math.max(worst, Math.abs(ts.sun_el[k] - pub.sun_el[k]), Math.abs(ts.earth_el[k] - pub.earth_el[k]));
        const daz = Math.abs(ts.sun_az[k] - pub.sun_az[k]);
        worst = Math.max(worst, Math.min(daz, 36000 - daz));
      }
      expect(worst).toBeLessThanOrEqual(1); // 0.01°
    });
  }

  for (const L of manifest.params.window_days) {
    it(`score on the five sites' scale gives the published score back (${L} days)`, () => {
      const all = manifest.sites.map((id) => json<Windows>(`windows/${id}_${L}d.json`).rows);
      const scale = scoreScale(all);
      let worst = 0;
      for (const rows of all) for (const r of rows) worst = Math.max(worst, Math.abs(scoreRow(r, scale, manifest.params.score_weights) - r.score));
      expect(worst).toBeLessThanOrEqual(1e-4 + 1e-12);
      // a point better (or worse) than every candidate stays in [0, 1]
      const best = { start: "2027-01-01T00:00:00Z", sun_pct: 100, longest_dark_h: 0, earth_h_min: 24, earth_h_mean: 24, longest_comm_gap_h: 0 };
      expect(scoreRow(best, scale, manifest.params.score_weights)).toBe(1);
      expect(scoreRow({ ...best, sun_pct: 0, longest_dark_h: 1000, earth_h_mean: 0 }, scale, manifest.params.score_weights)).toBe(0);
    });
  }

  it("plans: 365 days × 3 stays with the contract's ids", () => {
    const id = customSiteId(-88.5, 45);
    expect(id).toBe("custom_s885000_e450000");
    const plans = virtualPlans(id, json("manifest.json"));
    expect(plans).toHaveLength(365 * 3);
    expect(PlansSchema.safeParse(plans).success).toBe(true);
    expect(plans[0]).toMatchObject({ id: `${id}_20270101_3d`, trajectory_id: `${id}_20270101`, launch_utc: "2026-12-29T00:00:00Z" });
  });
});

describe.runIf(HAS_TERRAIN)("virtual site over the reduced relief", () => {
  let terrain: CustomTerrain;
  beforeAll(() => {
    const header = json<CustomTerrainHeader>("terrain_custom/terrain.json");
    terrain = {
      header,
      fine: parseLevel(header.fine, bin(`terrain_custom/${header.fine.bin_file}`), header.height_scale_m),
      coarse: parseLevel(header.coarse, bin(`terrain_custom/${header.coarse.bin_file}`), header.height_scale_m),
    };
  });

  for (const s of SITES) {
    it(`${s.id}: lod0 and lod1 from the reduced relief vs the published 40 m levels`, () => {
      for (const lod of [0, 1]) {
        const ours = terrainLevel(terrain, s, lod);
        expect(TerrainHeaderSchema.safeParse(ours.header).success).toBe(true);
        const h = json<{ grid: { nx: number; ny: number; spacing_m: number; x0_m: number }; height_scale_m: number; height_offset_m: number }>(`terrain/${s.id}/lod${lod}.json`);
        expect([ours.header.grid.nx, ours.header.grid.spacing_m, ours.header.grid.x0_m]).toEqual([h.grid.nx, h.grid.spacing_m, h.grid.x0_m]);
        const pub = new Int16Array(bin(`terrain/${s.id}/lod${lod}.bin`));
        let sq = 0;
        for (let i = 0; i < pub.length; i++) sq += (ours.heights[i] - (pub[i] * h.height_scale_m + h.height_offset_m)) ** 2;
        const rms = Math.sqrt(sq / pub.length);
        console.log(`terrain ${s.id} lod${lod}: RMS ${rms.toFixed(1)} m (reduced relief vs 40 m DEM)`);
        // 160 m block means against the 40 m DEM, both sampled at the 300 m / 100 m nodes: measured 1.6–3.0 m RMS
        expect(rms).toBeLessThan(5);
      }
    });
  }

  it("lod2 does not exist for a custom point", () => {
    expect(() => terrainLevel(terrain, SITES[0], 2)).toThrow(/lod2/);
  });

  it("every file of a virtual site passes the contract schemas through the DataStore", async () => {
    const data = fileStore();
    const made = await createVirtualSite(data, -88.5, 45);
    expect(made).not.toBeNull();
    const { site, provider } = made!;
    expect(await createVirtualSite(data, -84.5, 0)).toBeNull(); // north of 85°S
    data.registerVirtualSite(provider);
    expect(data.virtualSite(site.id)).toBe(site);
    const [hz, ts, daily, w7, features, lod0, traj] = await Promise.all([
      data.horizon(site.id),
      data.timeseries(site.id),
      data.daily(site.id),
      data.windows(site.id, 7),
      data.siteFeatures(site.id),
      data.terrain(site.id, 0),
      data.trajectory(`${site.id}_20270615`),
    ]);
    expect(hz.elev_deg).toHaveLength(360);
    expect(ts.n).toBe(SKY.header.n);
    expect(daily.days[0].date).toBe("2027-01-01");
    expect(w7.rows).toHaveLength(365);
    expect(w7.rows.every((r) => r.score >= 0 && r.score <= 1)).toBe(true);
    expect(features.attributes.find((a) => a.key === "elevation_m")?.value).toBe(site.elevation_m);
    expect(features.nearby_features.length).toBeGreaterThan(0);
    expect(lod0.header.origin.elevation_m).toBe(site.elevation_m);
    expect(traj.mode).toBe("ILLUSTRATIVE");
    expect(traj.phases.landing_utc).toBe("2027-06-15T00:00:00Z");
    await expect(data.terrain(site.id, 2)).rejects.toThrow();
    // cached like a file
    expect(await data.trajectory(`${site.id}_20270615`)).toBe(traj);
    data.unregisterVirtualSite(site.id);
    expect(data.virtualSite(site.id)).toBeUndefined();
  });

  it("the store keeps a custom point while one of its plans is pinned, and drops it once unused", async () => {
    const store = createAppStore(fileStore());
    await store.getState().loadCore();
    const st = () => store.getState();
    const n = st().plansById.size;
    const id = await st().addCustomSite(-88.5, 45);
    expect(id).toBe("custom_s885000_e450000");
    expect(st().plansById.size).toBe(n + 365 * 3);
    expect(st().sites).toHaveLength(5); // the candidates stay five
    // a second point replaces an unused first one
    const id2 = await st().addCustomSite(-87, -120);
    expect(st().customSite?.id).toBe(id2);
    expect(st().customSites.map((c) => c.id)).toEqual([id2]);
    expect(st().plansById.size).toBe(n + 365 * 3);
    // pinned, the first point stays beside the next one: they can be compared
    await st().addCustomSite(-88.5, 45);
    expect(st().pinPlan(`${id}_20270301_7d`)).toBe(true);
    st().pinPlan("haworth_20270301_7d");
    await st().addCustomSite(-87, -120);
    st().pinPlan(`${id2}_20270301_7d`);
    expect(st().customSites.map((c) => c.id).sort()).toEqual([id, id2].sort());
    expect(st().plansById.size).toBe(n + 2 * 365 * 3);
    expect(st().comparePlans).toEqual([`${id}_20270301_7d`, "haworth_20270301_7d", `${id2}_20270301_7d`]);
    // unpinned and not current: gone, with its plans
    st().unpinPlan(`${id}_20270301_7d`);
    expect(st().customSites.map((c) => c.id)).toEqual([id2]);
    expect(st().plansById.size).toBe(n + 365 * 3);
    st().removeCustomSite();
    expect(st().customSite).toBeNull();
    expect(st().comparePlans).toEqual(["haworth_20270301_7d"]);
    expect(st().plansById.size).toBe(n);
  });

  it("scene geometry (3D) = sky from the point (2D) at a custom site: Sun and Earth within 0.05°", async () => {
    const made = await createVirtualSite(fileStore(), -88.5, 45);
    const site = made!.site;
    const ix = indexEphemeris(json<SceneEphemeris>("scene/ephemeris.json"));
    const s = skyFrom(SKY, site.lat, site.lon, site.elevation_m, 0);
    const R = 1737.4 + site.elevation_m / 1000;
    const la = (site.lat * Math.PI) / 180;
    const lo = (site.lon * Math.PI) / 180;
    const body: [number, number, number] = [R * Math.cos(la) * Math.cos(lo), R * Math.cos(la) * Math.sin(lo), R * Math.sin(la)];
    const el = (up: number[], dir: number[]) => 90 - (Math.acos((up[0] * dir[0] + up[1] * dir[1] + up[2] * dir[2]) / (Math.hypot(...up) * Math.hypot(...dir))) * 180) / Math.PI;
    let worstSun = 0;
    let worstEarth = 0;
    for (let k = 0; k < s.n; k += 97) {
      const st = sceneStateAt(ix, s.startMs + k * s.stepMin * 60_000);
      const up = rotate(st.moonQuat, body);
      const pos = [st.moonKm[0] + up[0], st.moonKm[1] + up[1], st.moonKm[2] + up[2]];
      worstEarth = Math.max(worstEarth, Math.abs(el(up, [-pos[0], -pos[1], -pos[2]]) - s.earthEl[k]));
      worstSun = Math.max(worstSun, Math.abs(el(up, st.sunDir) - s.sunEl[k]));
    }
    console.log(`sky at ${site.id}: max |Δ sun_el| = ${worstSun.toFixed(3)}°, max |Δ earth_el| = ${worstEarth.toFixed(3)}°`);
    expect(worstSun).toBeLessThan(0.05);
    expect(worstEarth).toBeLessThan(0.05);
  });
});
