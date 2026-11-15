// @vitest-environment jsdom
/**
 * B13 (decision A14): the whole journey to a custom coordinate. "Launch to this point" makes the point a site of its
 * own, selects the plan of the panel's arrival and stay, and plays the journey like the five candidate sites (with
 * the trajectory built in the browser); "Jump to" reaches every phase; "Back to planning" keeps the site; "Land here"
 * opens the site directly. The scene itself is replaced by a stub (no WebGL in jsdom).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
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
  for (const id of [...st.comparePlans]) st.unpinPlan(id);
  for (const c of [...appStore.getState().customSites]) appStore.getState().removeCustomSite(c.id);
});
afterEach(cleanup);

const ID = "custom_s885000_e450000";

async function openPoint() {
  render(<App />);
  act(() => appStore.getState().setScreen("planner"));
  act(() => appStore.getState().openCustomAt(-88.5, 45));
  const drawer = within(await screen.findByTestId("custom-drawer"));
  await drawer.findByTestId("custom-go", {}, { timeout: 8000 });
  fireEvent.change(drawer.getByLabelText("Arrival date at the custom site (UTC)"), { target: { value: "2027-03-09" } });
  return drawer;
}

describe.runIf(HAS_TERRAIN)("Journey to a custom coordinate (B13)", () => {
  it("'Launch to this point' plays the journey; Jump to reaches every phase; Back to planning keeps the site", async () => {
    const drawer = await openPoint();
    fireEvent.click(drawer.getByRole("button", { name: "Launch to this point" }));
    await waitFor(() => expect(appStore.getState().viewMode).toBe("live"), { timeout: 8000 });
    const st = appStore.getState();
    expect(st.selectedPlanId).toBe(`${ID}_20270309_7d`);
    expect(st.customSite?.id).toBe(ID);
    expect(screen.queryByTestId("custom-drawer")).toBeNull(); // the panel closed
    expect(screen.getByTestId("scene-host")).toBeTruthy();
    // the trajectory comes from the browser, through the DataStore, like a file
    const traj = await st.data.trajectory(`${ID}_20270309`);
    expect(traj.mode).toBe("ILLUSTRATIVE");
    expect(traj.phases.launch_utc).toBe("2027-03-06T00:00:00Z");

    await screen.findByTestId("mission-controls", {}, { timeout: 5000 });
    expect(screen.getByText(/Custom site · -88\.500°, 45\.000°/)).toBeTruthy(); // telemetry title
    expect(screen.getByTestId("illustrative-label")).toBeTruthy();
    expect(screen.getByTestId("approx-scene")).toBeTruthy();
    await waitFor(() => expect(appStore.getState().missionPhase).toBe("launch")); // autoplay from the countdown
    fireEvent.click(screen.getByRole("button", { name: "Pause the mission" }));

    for (const [button, phase] of [
      ["Transit", "transit"],
      ["Landing", "landing"],
      ["At the site", "site"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: button }));
      await waitFor(() => expect(appStore.getState().missionPhase).toBe(phase));
    }
    expect(appStore.getState().missionTime).toBe(Date.parse("2027-03-09T00:00:00Z"));
    // the site view of the custom point, with its time left marked APPROXIMATE
    const site = await screen.findByTestId("live-site");
    expect(await within(site).findByTestId("time-left", {}, { timeout: 8000 })).toBeTruthy();
    expect(within(site).getByTestId("approx-time-left").textContent).toBe("APPROXIMATE");
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    expect(await within(site).findByTestId("panorama", {}, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Back to planning/ }));
    await waitFor(() => expect(appStore.getState().viewMode).toBe("compare"));
    expect(appStore.getState().selectedPlanId).toBe(`${ID}_20270309_7d`);
    expect(appStore.getState().customSite?.id).toBe(ID);
    const brief = await screen.findByTestId("site-brief");
    expect(within(brief).getByRole("heading", { name: /Custom site/ })).toBeTruthy();
  });

  it("'Land here' opens the site directly, at the arrival", async () => {
    const drawer = await openPoint();
    fireEvent.click(drawer.getByRole("button", { name: "Land here" }));
    await waitFor(() => expect(appStore.getState().viewMode).toBe("live"), { timeout: 8000 });
    expect(appStore.getState().missionPhase).toBe("site");
    expect(appStore.getState().missionTime).toBe(Date.parse("2027-03-09T00:00:00Z"));
    const site = await screen.findByTestId("live-site");
    expect(await within(site).findByTestId("time-left", {}, { timeout: 8000 })).toBeTruthy();
  });

  it("choosing a candidate site afterwards leaves the custom point for the same day and stay", async () => {
    const drawer = await openPoint();
    fireEvent.click(drawer.getByRole("button", { name: "Land here" }));
    await waitFor(() => expect(appStore.getState().viewMode).toBe("live"), { timeout: 8000 });
    act(() => appStore.getState().setViewMode("compare"));
    act(() => appStore.getState().selectSite("haworth"));
    expect(appStore.getState().selectedPlanId).toBe("haworth_20270309_7d");
  });

  it("pins the point's plan to the tray and compares it with a candidate site and another point (B13b)", async () => {
    const drawer = await openPoint();
    fireEvent.click(drawer.getByTestId("custom-pin"));
    await waitFor(() => expect(appStore.getState().comparePlans).toEqual([`${ID}_20270309_7d`]), { timeout: 8000 });
    expect(drawer.getByTestId("custom-pin").getAttribute("aria-pressed")).toBe("true");
    act(() => {
      appStore.getState().pinPlan("haworth_20270309_7d");
    });
    // a second point, pinned too: the first one is kept
    fireEvent.change(drawer.getByLabelText("Latitude, longitude"), { target: { value: "-87, -120" } });
    fireEvent.click(drawer.getByRole("button", { name: "Analyse" }));
    await waitFor(() => expect(drawer.getByTestId("custom-pin").getAttribute("aria-pressed")).toBe("false"));
    fireEvent.click(drawer.getByTestId("custom-pin"));
    await waitFor(() => expect(appStore.getState().comparePlans).toHaveLength(3), { timeout: 8000 });
    expect(appStore.getState().customSites).toHaveLength(2);

    fireEvent.click(drawer.getByRole("button", { name: "Compare pinned (3)" }));
    const search = within(await screen.findByTestId("search-drawer"));
    expect(screen.queryByTestId("custom-drawer")).toBeNull();
    const grid = await search.findByTestId("tray-grid", {}, { timeout: 5000 });
    await waitFor(() => expect(within(grid).getAllByTestId("plan-panel")).toHaveLength(3), { timeout: 8000 });
    const names = within(grid).getAllByTestId("plan-panel").map((p) => p.querySelector(".plan-site")?.textContent);
    expect(names).toEqual(["Custom site · -88.500°, 45.000°", "Haworth", "Custom site · -87.000°, -120.000°"]);
    expect(within(grid).getAllByTestId("approx-panel")).toHaveLength(2); // the two points, not Haworth
    // every panel has its metrics, so the best values are marked across the three
    expect(within(grid).getAllByTestId("metrics-box")).toHaveLength(3);
  });
});
