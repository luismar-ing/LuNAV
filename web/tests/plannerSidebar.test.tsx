// @vitest-environment jsdom
/** TR.2.b: the Mission Planner sidebar (A2) picks the plan; "Launch" starts the mission from the countdown. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { appStore } from "../src/store/appStore";

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
});
afterEach(cleanup);

const sidebar = () => within(screen.getByTestId("mission-sidebar"));

describe("Mission Planner sidebar (A2)", () => {
  it("opens on the default plan; day, stay and site each select the matching plan", async () => {
    render(<App />);
    act(() => appStore.getState().setScreen("planner"));
    expect(appStore.getState().selectedPlanId).toBe("connecting_ridge_20270101_7d");
    // planning is 2D (planner redesign): the Moon map instead of the globe, no WebGL until the journey
    expect(screen.queryByTestId("scene-host")).toBeNull();
    expect(screen.getByTestId("moon-map")).toBeTruthy();

    // B2 (H6): the default plan is sunlit but has no Earth for the whole stay: list, pin and brief all say so
    const cr = sidebar().getByRole("button", { name: /^Connecting Ridge/ });
    await waitFor(() => expect(cr.querySelector(".site-status")?.textContent).toBe(", Sunlit all stay · No Earth all stay"));
    expect(cr.querySelector(".site-status")?.getAttribute("data-tone")).toBe("poor");
    const pin = within(screen.getByTestId("moon-map")).getByRole("button", { name: "Connecting Ridge (Shackleton rim)" });
    expect(pin.dataset).toMatchObject({ sun: "lit", earth: "none", tone: "poor" });
    expect((await screen.findByTestId("brief-verdict")).textContent).toBe("Sunlit all stay, but no direct Earth contact at any time.");

    fireEvent.click(sidebar().getByRole("button", { name: "Next day" }));
    expect(appStore.getState().selectedPlanId).toBe("connecting_ridge_20270102_7d");

    fireEvent.change(sidebar().getByLabelText("Arrival date (UTC)"), { target: { value: "2027-03-09" } });
    expect(appStore.getState().selectedPlanId).toBe("connecting_ridge_20270309_7d");
    // B5 (H12): the date reads like the rest of the app, not in the system's format
    expect(sidebar().getByTestId("arrival-text").textContent).toBe("Mar 9, 2027");

    // (the < 100 ms update budget is measured in the browser, not under jsdom: see PROGRESS, TR.2.b)
    fireEvent.click(sidebar().getByRole("button", { name: "14 days" }));
    fireEvent.click(sidebar().getByRole("button", { name: /^Haworth/ }));
    expect(appStore.getState().selectedPlanId).toBe("haworth_20270309_14d");
    expect(sidebar().getByRole("button", { name: /^Haworth/ }).getAttribute("aria-pressed")).toBe("true");

    // the strip marks its days from the window index once it is loaded (score in the label); clicking a day selects it
    await waitFor(() => expect(sidebar().getAllByRole("button", { name: /score/ }).length).toBeGreaterThan(10));
    fireEvent.click(sidebar().getByRole("button", { name: /^Mar 11, 2027: / }));
    expect(appStore.getState().selectedPlanId).toBe("haworth_20270311_14d");
  });

  it("'Launch' leaves the globe for the mission, at the countdown and playing; 'Search and compare' opens the panel", async () => {
    render(<App />);
    act(() => appStore.getState().setScreen("planner"));
    fireEvent.click(sidebar().getByRole("button", { name: "Search and compare" }));
    expect(screen.getByTestId("search-drawer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("search-drawer")).toBeNull();

    fireEvent.click(sidebar().getByRole("button", { name: /^Launch · Dec 29, 2026/ }));
    expect(appStore.getState().viewMode).toBe("live");
    expect(screen.queryByTestId("mission-sidebar")).toBeNull();
    await screen.findByTestId("mission-controls", {}, { timeout: 5000 });
    await waitFor(() => expect(appStore.getState().missionPhase).toBe("launch"));
    expect(screen.getByRole("button", { name: /Pause the mission/ })).toBeTruthy(); // playing
    expect(screen.getByRole("list", { name: "Mission phases" }).querySelector('[aria-current="step"]')?.textContent).toBe("Launch");
  });

  it("search panel (TR.2.c): focus goes in and stays in, Esc closes it and returns focus; during the journey Esc closes only the panel", async () => {
    render(<App />);
    act(() => appStore.getState().setScreen("planner"));
    const opener = sidebar().getByRole("button", { name: "Search and compare" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Search and compare plans" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true }); // first element: Shift+Tab wraps to the last
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(close);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Search and compare plans" })).toBeNull();
    expect(document.activeElement).toBe(opener);

    fireEvent.click(sidebar().getByRole("button", { name: /^Launch/ }));
    await screen.findByTestId("mission-controls", {}, { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Search and compare" })); // from the journey too
    const d2 = screen.getByRole("dialog", { name: "Search and compare plans" });
    fireEvent.keyDown(within(d2).getByRole("button", { name: "Close" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Search and compare plans" })).toBeNull();
    expect(appStore.getState().viewMode).toBe("live"); // the journey's own Esc did not fire
  });

  it("arrival (TR.2.e): ILLUSTRATIVE before landing only; metrics card, panorama on the mission clock, ★ against pinned plans", async () => {
    const st = appStore.getState();
    st.setScreen("planner");
    st.selectPlan("haworth_20270309_7d");
    st.pinPlan("haworth_20270309_7d");
    st.pinPlan("malapert_massif_20270309_7d");
    render(<App />);
    fireEvent.click(sidebar().getByRole("button", { name: /^Launch/ }));
    await screen.findByTestId("mission-controls", {}, { timeout: 5000 });
    expect(screen.getByTestId("illustrative-label")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause the mission" }));
    fireEvent.click(screen.getByRole("button", { name: "At the site" }));
    const site = await screen.findByTestId("live-site");
    expect(screen.queryByTestId("illustrative-label")).toBeNull(); // the site itself is real data
    const card = await within(site).findByRole("complementary", { name: "Time left" }, { timeout: 5000 });
    expect(await within(card).findByTestId("time-left", {}, { timeout: 5000 })).toBeTruthy();
    // A10: the sky first; the 2D console is the "Data" view
    expect(within(site).queryByTestId("panorama")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    expect(within(site).getByTestId("metrics-box")).toBeTruthy(); // in the console's "Window metrics" tab
    // the panorama follows the mission clock: arrival = sample 0
    await waitFor(() => expect(within(site).getByTestId("panorama").dataset.sample).toBe("0"));
    fireEvent.click(within(site).getByRole("tab", { name: "Window metrics" })); // beside "What happens next"
    const table = await within(site).findByTestId("site-compare-mini");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Metric", "This plan", "Malapert Massif"]);
    expect(within(table).getAllByText("★").length + table.querySelectorAll('[data-best="true"]').length).toBeGreaterThan(0);
    fireEvent.click(within(site).getByRole("button", { name: "Site details and sources" }));
    expect(screen.getByRole("dialog", { name: "Haworth: details and sources" })).toBeTruthy();
    for (const id of ["haworth_20270309_7d", "malapert_massif_20270309_7d"]) appStore.getState().unpinPlan(id);
  });

  it("Level B switch (T6.1.c): off keeps the arrival working (panorama, metrics) and the choice in the store", async () => {
    const st = appStore.getState();
    st.setLevelB(true);
    st.setScreen("planner");
    st.selectPlan("haworth_20270309_7d");
    render(<App />);
    fireEvent.click(sidebar().getByRole("button", { name: /^Launch/ }));
    await screen.findByTestId("mission-controls", {}, { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Pause the mission" }));
    fireEvent.click(screen.getByRole("button", { name: "At the site" }));
    const site = await screen.findByTestId("live-site");
    const toggle = await within(site).findByRole("button", { name: /3D terrain shadows/ }, { timeout: 5000 });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(appStore.getState().levelB).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    expect(within(site).getByTestId("panorama")).toBeTruthy();
    expect(within(site).getByTestId("metrics-box")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sky" }));
    fireEvent.click(within(site).getByRole("button", { name: /3D terrain shadows/ }));
    expect(appStore.getState().levelB).toBe(true);
  });

  it("planner redesign: map pins pick the site, the brief shows the stay, 'Land at' opens the site paused; Sky | Data keeps the instant", async () => {
    const st = appStore.getState();
    st.setScreen("planner");
    st.selectPlan("haworth_20270111_7d");
    render(<App />);
    const map = screen.getByTestId("moon-map");
    await waitFor(() => expect(within(map).getAllByRole("button")).toHaveLength(5));
    fireEvent.click(within(map).getByRole("button", { name: "de Gerlache Rim 2" }));
    expect(appStore.getState().selectedPlanId).toBe("de_gerlache_rim_2_20270111_7d");
    fireEvent.click(within(map).getByRole("button", { name: "Haworth" }));
    expect(within(map).getByRole("button", { name: "Haworth" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(map).getByText("52 km")).toBeTruthy(); // to Malapert Massif, the nearest other site

    // the sidebar names each site's night for these dates (same data as REDIS); the brief has no sentence (A9)
    // B6 (H7): Jan 1, 9 and 11 at Haworth tell apart by shape (Sun mark, Earth mark), not by two shades of green
    const cell = (d: string) => sidebar().getByRole("button", { name: new RegExp(`^${d}, 2027: `) });
    await waitFor(() => expect(cell("Jan 11").dataset.sun).toBe("night"));
    expect([cell("Jan 1"), cell("Jan 9"), cell("Jan 11")].map((c) => `${c.dataset.sun}/${c.dataset.earth}`)).toEqual(["night/gaps", "lit/all", "night/all"]);
    expect(cell("Jan 11").getAttribute("aria-label")).toBe("Jan 11, 2027: 34 h night in stay · Earth all stay · score 0.86");

    // B7 (H16): the ASSUMED battery in the brief, and the same site a day earlier or later in the same format
    expect((await screen.findByTestId("brief-battery")).textContent).toBe("ASSUMED Battery runs empty for 14.5 h");
    fireEvent.click(screen.getByRole("tab", { name: "Same site, ±1 day" }));
    expect([...screen.getByTestId("brief-days").querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Jan 10 · day before≥ 50%+14.3 % sun",
      "Jan 11empty 14.5 hthis plan",
      "Jan 12 · day afterempty 17.0 h−1.5 % sun",
    ]);
    fireEvent.click(screen.getByRole("button", { name: /^Jan 10 · day before/ }));
    expect(appStore.getState().selectedPlanId).toBe("haworth_20270110_7d");
    await waitFor(() => expect(screen.getByTestId("brief-battery").textContent).toBe("ASSUMED Battery never below 50%"));
    fireEvent.click(screen.getByRole("button", { name: /^Jan 11 · day after/ }));
    expect(appStore.getState().selectedPlanId).toBe("haworth_20270111_7d");
    fireEvent.click(screen.getByRole("tab", { name: "Same day, other sites" }));

    // B3: one night, one figure in context: 34 h of the 36.5 h night fall inside the 7-day stay
    await waitFor(() => expect(sidebar().getByRole("button", { name: /^Haworth/ }).textContent).toContain("34 h night in stay"));
    expect((await screen.findByTestId("brief-night-of")).textContent).toBe("of 36.5 h");
    expect(screen.getByTestId("brief-verdict").textContent).toBe("34 h of night in the stay, with the Earth in view the whole time.");
    // B4: the sunset (day 6) is counted down; the Earthset (Jan 26) is after the stay: "Up all stay", date aside
    expect(screen.getByTestId("brief-count-sun").textContent).toBe("Sets in 5 d 14 h");
    expect(screen.getByTestId("brief-count-earth").textContent).toBe("Up all stay · sets Jan 26");
    expect(screen.queryByTestId("brief-story")).toBeNull();
    expect(within(screen.getByTestId("brief-others")).getAllByRole("listitem")[0].textContent).toMatch(/^Malapert Massif52 km\+20\.2 % sun$/);

    fireEvent.click(screen.getByRole("button", { name: "Land at Haworth" }));
    expect(appStore.getState().viewMode).toBe("live");
    expect(appStore.getState().missionPhase).toBe("site");
    expect(appStore.getState().missionTime).toBe(Date.parse("2027-01-11T00:00:00Z"));
    await screen.findByTestId("mission-controls", {}, { timeout: 5000 });
    expect(screen.getByRole("button", { name: "Play the mission" })).toBeTruthy(); // paused at the landing
    const site = await screen.findByTestId("live-site");
    const sun = await within(site).findByTestId("countdown-sun", {}, { timeout: 5000 });
    expect(sun.textContent).toContain("5 d 14 h");
    expect(sun.textContent).toContain("Sunset Jan 16, 14:00 UTC");
    expect(sun.textContent).toContain("Then a 36.5 h night, 34 h of it in your stay.");
    const earth = within(site).getByTestId("countdown-earth");
    expect(earth.textContent).toBe("Earth link leftAll stayEarthset Jan 26, 20:30 UTC · after you leave"); // B4: no "15 d 20 h"
    expect(earth.dataset.withinStay).toBe("false");

    // A10: the sky (3D, countdowns) and the data (2D console) on the same mission clock
    expect(within(site).queryByTestId("site-console")).toBeNull();
    const at = appStore.getState().missionTime;
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    expect(screen.getByRole("button", { name: "Data" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(site).queryByTestId("countdown-sun")).toBeNull();
    expect(within(site).getByTestId("next-events").querySelector("li")?.textContent).toMatch(/^5 d 14 hSunset/);
    fireEvent.click(within(site).getByRole("tab", { name: "Window metrics" }));
    expect(within(site).getByTestId("metrics-box").closest("[role=tabpanel]")?.hasAttribute("hidden")).toBe(false);
    expect(within(site).getByTestId("panorama")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sky" }));
    expect(within(site).queryByTestId("panorama")).toBeNull();
    expect(within(site).getByTestId("countdown-sun").textContent).toContain("5 d 14 h");
    expect(appStore.getState().missionTime).toBe(at);
    act(() => appStore.getState().setViewMode("compare"));
  });
});
