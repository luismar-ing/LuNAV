// @vitest-environment jsdom
/** B11 (decision A12): "Find the best plan" in the Mission Planner, over the real data. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { search } from "../src/lib/optimizer";
import { appStore, DEFAULT_CONSTRAINTS } from "../src/store/appStore";

vi.mock("../src/scene3d/SceneHost", () => ({ SceneHost: () => <div data-testid="scene-host" /> }));

const REAL = join(__dirname, "..", "public", "data");
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
  st.setConstraints({ ...DEFAULT_CONSTRAINTS });
  st.setFinderOpen(false);
  for (const id of [...st.comparePlans]) st.unpinPlan(id);
});
afterEach(cleanup);

async function openFinder() {
  render(<App />);
  act(() => appStore.getState().setScreen("planner"));
  const opener = screen.getByTestId("open-finder");
  opener.focus();
  fireEvent.click(opener);
  const drawer = await screen.findByTestId("finder-drawer");
  await within(drawer).findByTestId("finder-summary");
  return { drawer: within(drawer), opener };
}

describe("Find the best plan (B11)", () => {
  it("lists the best plan of each site, as the exact search says, and follows the limits", async () => {
    const { drawer } = await openFinder();
    const index = appStore.getState().windowIndex[7]!;
    const all = search(index, { constraints: { ...DEFAULT_CONSTRAINTS }, from: null, to: null, order: "best" });
    expect(drawer.getByTestId("finder-summary").textContent).toBe(`${all.valid.toLocaleString("en-US")} of ${all.evaluated.toLocaleString("en-US")} 7-day plans meet your limits`);
    const ids = () => [...document.querySelectorAll<HTMLElement>(".finder-result")].map((li) => li.dataset.planId);
    expect(ids()).toEqual(all.bySite.map((r) => r.planId));

    // turn on "Maximum darkness" and set it to 0 h: the list follows
    fireEvent.click(drawer.getByRole("checkbox", { name: /Maximum darkness/ }));
    fireEvent.change(drawer.getByRole("slider", { name: "Maximum darkness" }), { target: { value: "0" } });
    const dark0 = search(index, { constraints: { ...DEFAULT_CONSTRAINTS, maxDarkH: 0 }, from: null, to: null, order: "best" });
    await waitFor(() => expect(ids()).toEqual(dark0.bySite.map((r) => r.planId)));
    for (const r of dark0.bySite) expect(r.row.longest_dark_h).toBe(0);
  });

  it("Select makes it the plan of the sidebar and closes the panel; Pin adds it to the tray", async () => {
    await openFinder();
    const first = document.querySelector<HTMLElement>(".finder-result")!;
    const planId = first.dataset.planId!;
    fireEvent.click(within(first).getByRole("button", { name: /^Pin / }));
    expect(appStore.getState().comparePlans).toContain(planId);
    expect(within(first).getByRole("button", { name: /^Pin / }).textContent).toBe("Pinned");

    fireEvent.click(within(first).getByRole("button", { name: /^Select / }));
    expect(appStore.getState().selectedPlanId).toBe(planId);
    expect(screen.queryByTestId("finder-drawer")).toBeNull();
  });

  it("a 14-day stay selected from the panel switches the sidebar's stay", async () => {
    const { drawer } = await openFinder();
    fireEvent.click(drawer.getByRole("button", { name: "14 days" }));
    await waitFor(() => expect(document.querySelector<HTMLElement>(".finder-result")?.dataset.planId).toMatch(/_14d$/));
    fireEvent.click(within(document.querySelector<HTMLElement>(".finder-result")!).getByRole("button", { name: /^Select / }));
    expect(appStore.getState().plansById.get(appStore.getState().selectedPlanId!)?.window_days).toBe(14);
  });

  it("with no plan left it says so and offers the best reachable value, which brings plans back", async () => {
    act(() => appStore.getState().setConstraints({ minSunPct: 99, maxDarkH: 0, minEarthH: 23 }));
    const { drawer } = await openFinder();
    // an arrival day where nothing meets these limits (checked against the exact search)
    const index = appStore.getState().windowIndex[7]!;
    const c = appStore.getState().constraints;
    const days = index.rows[index.siteIds[0]].map((r) => r.start.slice(0, 10));
    const empty = days.find((d) => search(index, { constraints: c, from: d, to: d, order: "best" }).valid === 0);
    expect(empty).toBeDefined();
    fireEvent.change(drawer.getByLabelText("Earliest arrival date (UTC)"), { target: { value: empty } });
    fireEvent.change(drawer.getByLabelText("Latest arrival date (UTC)"), { target: { value: empty } });
    const none = await drawer.findByTestId("finder-none");
    expect(none.textContent).toContain("No plan meets all your limits.");
    const use = within(none).queryAllByRole("button", { name: /^Use / });
    expect(use.length).toBeGreaterThan(0);
    fireEvent.click(use[0]);
    await waitFor(() => expect(document.querySelectorAll(".finder-result").length).toBeGreaterThan(0));
  });

  it("Esc closes the panel and the focus goes back to the button that opened it", async () => {
    const { opener } = await openFinder();
    fireEvent.keyDown(screen.getByTestId("finder-drawer"), { key: "Escape" });
    expect(screen.queryByTestId("finder-drawer")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
