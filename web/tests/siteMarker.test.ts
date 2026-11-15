// @vitest-environment jsdom
/** C3c: the landing point's marker for the aerial view — on the ground at the site, a beacon along the vertical. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { bodyFixedKm, enuBasis, MARKER_M, siteMarker, TerrainManager } from "../src/scene3d/terrain";
import { MOON_RADIUS_KM, type Vec3 } from "../src/scene3d/scale";

const sites = JSON.parse(readFileSync(join(__dirname, "..", "public", "data", "sites.json"), "utf-8")) as {
  id: string;
  lat: number;
  lon: number;
  elevation_m: number;
}[];
const site = sites.find((s) => s.id === "haworth")!;
const siteKm: Vec3 = bodyFixedKm(site.lat, site.lon, MOON_RADIUS_KM + site.elevation_m / 1000);
const M = 1e6; // scene units → m
const points = (o: THREE.Object3D): Vec3[] => {
  const a = ((o as THREE.Mesh).geometry as THREE.BufferGeometry).getAttribute("position");
  return Array.from({ length: a.count }, (_, i) => [a.getX(i) * M, a.getY(i) * M, a.getZ(i) * M] as Vec3);
};
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe("landing marker (C3c)", () => {
  const marker = siteMarker(siteKm);
  const { up } = enuBasis(siteKm);

  it("a ring around the landing point, flat on the local ground, just above it", () => {
    const ring = points(marker.getObjectByName("site-marker-ring")!);
    for (const p of ring) {
      const h = dot(p, up); // height above the site (m)
      expect(h).toBeCloseTo(10, 3);
      const r = Math.hypot(p[0] - up[0] * h, p[1] - up[1] * h, p[2] - up[2] * h);
      expect(r).toBeGreaterThan(MARKER_M.ring - MARKER_M.ringWidth / 2 - 1e-3);
      expect(r).toBeLessThan(MARKER_M.ring + MARKER_M.ringWidth / 2 + 1e-3);
    }
  });

  it("a beacon rising along the local vertical from the landing point", () => {
    const [a, b] = points(marker.getObjectByName("site-marker-beacon")!);
    expect(dot(a, up)).toBeCloseTo(10, 3);
    expect(dot(b, up)).toBeCloseTo(MARKER_M.beacon, 3);
    expect(Math.hypot(b[0] - up[0] * MARKER_M.beacon, b[1] - up[1] * MARKER_M.beacon, b[2] - up[2] * MARKER_M.beacon)).toBeLessThan(1e-3);
  });

  it("drawn over the terrain, and hidden when standing on the site", () => {
    const ring = marker.getObjectByName("site-marker-ring") as THREE.Mesh;
    expect((ring.material as THREE.Material).depthTest).toBe(false);
    const terrain = new TerrainManager("haworth", siteKm, () => new Promise(() => {}));
    expect(terrain.group.getObjectByName("site-marker")).toBe(terrain.marker);
    terrain.showMarker(false);
    expect(terrain.marker.visible).toBe(false);
    terrain.showMarker(true);
    expect(terrain.marker.visible).toBe(true);
  });
});
