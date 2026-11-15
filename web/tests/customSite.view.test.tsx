// @vitest-environment jsdom
/** B12 (decision A13): the "Custom coordinates" panel of the Mission Planner, over the real data. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { distanceKm, fractionToLatLon, mapFraction } from "../src/lib/moonMap";
import { appStore } from "../src/store/appStore";

vi.mock("../src/scene3d/SceneHost", () => ({ SceneHost: () => <div data-testid="scene-host" /> }));

const REAL = join(__dirname, "..", "public", "data");
const HAS_TERRAIN = existsSync(join(REAL, "terrain_custom", "terrain.json"));
const fileFetch = (async (url: string) => {
  try {
    return new Response(readFileSync(join(REAL, url.replace(/^.*\/data\//, ""))), { status: 200 });
  } catch {
    return new Response("", { status: 404 });
  }
}) as typeof fetch;

beforeAll(async () => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.fetch = fileFetch;
  window.scrollTo = () => {};
  await appStore.getState().loadCore();
});
beforeEach(() => {
  const st = appStore.getState();
  st.setScreen("landing");
  st.selectPlan(null);
  st.setCustomOpen(false);
});
afterEach(cleanup);

async function openPanel() {
  render(<App />);
  act(() => appStore.getState().setScreen("planner"));
  const opener = screen.getByTestId("open-custom");
  opener.focus();
  fireEvent.click(opener);
  const drawer = within(await screen.findByTestId("custom-drawer"));
  return { drawer, opener };
}

describe.runIf(HAS_TERRAIN)("Custom coordinates (B12)", () => {
  it("opens on the selected site's coordinates with the stay's metrics, the five sites and the panorama", async () => {
    const { drawer } = await openPanel();
    const table = await drawer.findByTestId("custom-table", {}, { timeout: 5000 });
    // default plan: Connecting Ridge, Jan 1, 7 days
    const rows = within(table).getAllByRole("row");
    expect(rows[1].textContent).toContain("This point");
    expect(drawer.getByTestId("custom-approx").textContent).toBe("APPROXIMATE");
    expect(drawer.getByTestId("custom-terrain-note").textContent).toMatch(/^Ground at \d+ m\. Horizon traced from this point/);
    // the five candidate sites are listed for the same arrival and stay
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2 + appStore.getState().sites.length));
    // the panorama of the stay, with its clock
    expect(drawer.getByRole("slider", { name: "Time in the stay" })).toBeTruthy();
    expect(screen.getByTestId("custom-site").querySelector(".panorama, [class*='panorama']")).toBeTruthy();
  });

  it("analyses a typed coordinate, and says when it is outside the terrain grid", async () => {
    const { drawer } = await openPanel();
    const input = drawer.getByLabelText("Latitude, longitude");
    fireEvent.change(input, { target: { value: "88.5S 45E" } });
    fireEvent.click(drawer.getByRole("button", { name: "Analyse" }));
    await waitFor(() => expect(drawer.getByRole("heading", { name: "Custom site · -88.500°, 45.000°" })).toBeTruthy());

    fireEvent.change(input, { target: { value: "-80, 0" } });
    fireEvent.click(drawer.getByRole("button", { name: "Analyse" }));
    await waitFor(() => expect(drawer.getByText(/Outside the terrain data/)).toBeTruthy());

    fireEvent.change(input, { target: { value: "not a place" } });
    fireEvent.click(drawer.getByRole("button", { name: "Analyse" }));
    expect(drawer.getByText(/Write the latitude and the longitude/)).toBeTruthy();
  });

  it("a best arrival day sets the arrival date", async () => {
    const { drawer } = await openPanel();
    const best = await drawer.findAllByRole("button", { name: / % sun · / }, { timeout: 5000 });
    fireEvent.click(best[0]);
    expect(best[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("Esc closes the panel and the focus goes back to the link that opened it", async () => {
    const { opener } = await openPanel();
    fireEvent.keyDown(screen.getByTestId("custom-drawer"), { key: "Escape" });
    expect(screen.queryByTestId("custom-drawer")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  // jsdom has no layout: give the map a 300 × 300 box at (100, 100) so clicks land on known points
  const box = (el: Element) =>
    Object.assign(el, { getBoundingClientRect: () => ({ left: 100, top: 100, width: 300, height: 300, right: 400, bottom: 400, x: 100, y: 100, toJSON() {} }) });

  it("a click on the panel's map analyses that point; the arrow keys move it 1 km", async () => {
    const { drawer } = await openPanel();
    await drawer.findByTestId("custom-table", {}, { timeout: 5000 });
    const disc = box(await drawer.findByRole("application"));
    const ext = (await appStore.getState().data.illumination()).extent_m;
    // three quarters of the way right, halfway down: a point on the 90°E side
    fireEvent.click(disc, { clientX: 325, clientY: 250 });
    const want = fractionToLatLon(ext, 0.75, 0.5);
    const input = drawer.getByLabelText("Latitude, longitude") as HTMLInputElement;
    expect(input.value).toBe(`${Number(want.lat.toFixed(4))}, ${Number(want.lon.toFixed(4))}`);
    await waitFor(() => expect(drawer.getByRole("heading", { name: `Custom site · ${want.lat.toFixed(3)}°, ${want.lon.toFixed(3)}°` })).toBeTruthy());
    const marker = drawer.getByTestId("point-picker-marker");
    const f = mapFraction(ext, want.lat, want.lon);
    expect(parseFloat(marker.style.left)).toBeCloseTo(f.fx * 100, 1);

    // the arrow keys: 1 km up on the map (Shift: 5 km), so the picker works without a pointer
    const before = input.value.split(",").map(Number);
    fireEvent.keyDown(disc, { key: "ArrowUp", shiftKey: true });
    const after = input.value.split(",").map(Number);
    const km = distanceKm({ lat: before[0], lon: before[1] }, { lat: after[0], lon: after[1] });
    expect(km).toBeGreaterThan(4.9);
    expect(km).toBeLessThan(5.1);

    // north of 85°S (the map's corner) nothing is picked
    fireEvent.click(disc, { clientX: 101, clientY: 101 });
    expect(input.value.split(",").map(Number)).toEqual(after);
  });

  it("a click on the planner's Moon map, away from the pins, opens the panel on that point", async () => {
    render(<App />);
    act(() => appStore.getState().setScreen("planner"));
    const map = await screen.findByTestId("moon-map");
    await waitFor(() => expect(map.textContent).toContain("Click anywhere on the map"));
    const disc = box(map.querySelector(".moon-map-disc")!);
    fireEvent.click(disc, { clientX: 250, clientY: 175 });
    const drawer = within(await screen.findByTestId("custom-drawer"));
    const ext = (await appStore.getState().data.illumination()).extent_m;
    const want = fractionToLatLon(ext, 0.5, 0.25);
    expect((drawer.getByLabelText("Latitude, longitude") as HTMLInputElement).value).toBe(`${Number(want.lat.toFixed(4))}, ${Number(want.lon.toFixed(4))}`);
    // a pin still selects its site and opens nothing
    act(() => appStore.getState().setCustomOpen(false));
    fireEvent.click(within(map).getByRole("button", { name: /^Haworth/ }));
    expect(appStore.getState().customOpen).toBe(false);
    expect(appStore.getState().selectedPlanId).toMatch(/^haworth_/);
  });
});
