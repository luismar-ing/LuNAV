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
  st.removeCustomSite();
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
});
