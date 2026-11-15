// @vitest-environment jsdom
/**
 * T5.1.a: linked views (spec 4.1: "choosing a plan, a site or a time in one view updates the others", spec 8).
 * One test per cell of the view × state matrix (the matrix itself is in PROGRESS.md): the change is made
 * through the UI of the source view, and every other view is checked in the DOM. Since decision A9 the views are
 * the comparison tray, the Moon map, the sidebar, the site brief and the live view (the calendar, the constraint
 * controls and the site section left the search panel).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { timelineOf } from "../src/lib/mission";
import { loadPlanData } from "../src/lib/planData";
import { longestZeroRun } from "../src/lib/ribbon";
import { fmtMetric, METRICS, num, round, type MetricKey } from "../src/lib/why";
import { appStore, DEFAULT_CONSTRAINTS } from "../src/store/appStore";

// the WebGL scene has its own tests; here it is a stub that still registers the plan-switch bridge
vi.mock("../src/scene3d/SceneHost", async () => {
  const { useEffect } = await import("react");
  const { sceneBridge } = await import("../src/scene3d/bridge");
  return {
    SceneHost: () => {
      useEffect(() => {
        sceneBridge.setPlan = () => {};
        return () => {
          sceneBridge.setPlan = null;
        };
      }, []);
      return <div data-testid="scene-host" />;
    },
  };
});

const DATA = join(__dirname, "..", "public", "data");
const fileFetch = (async (url: string) => {
  try {
    return new Response(readFileSync(join(DATA, url.replace(/^.*\/data\//, "").replace(/^\/base\//, ""))), { status: 200 });
  } catch {
    return new Response("", { status: 404 });
  }
}) as typeof fetch;

const W = 1200; // every element measures 1200 px wide (calendar layout, silhouettes, panorama)
const A = "haworth_20270309_7d";
const B = "malapert_massif_20271015_7d";
const C = "connecting_ridge_20270102_7d";
const HOUR = 3_600_000;

beforeAll(async () => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => W });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 200 });
  HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: W, bottom: 200, width: W, height: 200, toJSON() {} }) as DOMRect;
  window.scrollTo = () => {};
  globalThis.fetch = fileFetch;
  await appStore.getState().loadCore();
  await appStore.getState().loadWindows(7);
});

// a clean global state for every cell
beforeEach(() => {
  const st = appStore.getState();
  st.setScreen("planner"); // the compare and live views live in the Mission Planner screen (A7)
  st.setDrawerOpen(true); // the comparison tray: the search panel (TR.2.b, A9)
  st.setViewMode("compare");
  for (const id of [...st.comparePlans]) st.unpinPlan(id);
  st.selectPlan(null);
  st.selectSite(null);
  st.setWindow(7);
  st.setConstraints({ ...DEFAULT_CONSTRAINTS });
  st.setCompareTime(0);
});
afterEach(cleanup);

const plan = (id: string) => appStore.getState().plansById.get(id)!;
const arrivalMs = (id: string) => Date.parse(plan(id).arrival_utc);
const tray = () => screen.getByTestId("tray-grid");
const panelOf = (id: string) => tray().querySelector<HTMLElement>(`[data-plan-id="${id}"]`)!;
const map = () => within(screen.getByTestId("moon-map"));
const sidebar = () => within(screen.getByTestId("mission-sidebar"));
const brief = () => screen.getByTestId("site-brief");
const escapeRe = (s: string) => s.replace(/[()]/g, "\\$&");

async function renderApp(pinned: string[] = [], selected: string | null = null) {
  const st = appStore.getState();
  for (const id of pinned) st.pinPlan(id);
  if (selected) st.selectPlan(selected);
  render(<App />);
  await screen.findByTestId("search-drawer");
  if (pinned.length) await waitFor(() => expect(screen.getAllByTestId("plan-panel")).toHaveLength(pinned.length));
  if (selected) await screen.findByTestId("site-brief");
}

/** The site the planning stage shows: its pin on the Moon map, its row in the sidebar and the brief's title. */
async function stageShows(site: string) {
  await waitFor(() => expect(within(brief()).getByRole("heading", { level: 2 }).textContent).toBe(site));
  expect(map().getByRole("button", { name: site }).getAttribute("aria-pressed")).toBe("true");
  expect(sidebar().getByRole("button", { name: new RegExp(`^${escapeRe(site)}`) }).getAttribute("aria-pressed")).toBe("true");
}

/* ------------------------------------------------------------------ plan */

describe("plan", () => {
  it("tray title → plan selected: tray panel, Moon map pin, sidebar (site and date) and brief", async () => {
    await renderApp([A, B]);
    fireEvent.click(within(panelOf(A)).getByRole("button", { name: /Haworth/, pressed: false }));
    expect(appStore.getState().selectedPlanId).toBe(A);
    expect(panelOf(A).className).toContain("selected");
    expect(panelOf(B).className).not.toContain("selected");
    await stageShows("Haworth");
    expect((sidebar().getByLabelText("Arrival date (UTC)") as HTMLInputElement).value).toBe("2027-03-09");
  });

  it("tray 3D button → live view on that plan; a thumbnail switches it; back in planning every view shows the new plan", async () => {
    await renderApp([A, B, C]);
    fireEvent.click(screen.getByRole("button", { name: "Open Haworth in the 3D live view" }));
    expect(await screen.findByRole("heading", { name: "Live view · Haworth" })).toBeTruthy();
    const strip = await screen.findByTestId("thumb-strip");
    await waitFor(() => expect(within(strip).getAllByTestId("thumb")).toHaveLength(2));
    fireEvent.click(within(strip).getByRole("button", { name: /Show Connecting Ridge/ }));
    expect(await screen.findByRole("heading", { name: /Live view · Connecting Ridge/ })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.getAllByTestId("plan-panel")).toHaveLength(3));
    expect(panelOf(C).className).toContain("selected");
    await stageShows("Connecting Ridge (Shackleton rim)");
  });
});

/* ------------------------------------------------------------------ pinned plans */

describe("pinned plans", () => {
  it("brief 'Pin to compare' → tray panel and live thumbnails", async () => {
    const B2 = "malapert_massif_20270309_7d";
    await renderApp([A], A);
    fireEvent.click(map().getByRole("button", { name: "Malapert Massif" }));
    expect(appStore.getState().selectedPlanId).toBe(B2);
    fireEvent.click(within(brief()).getByRole("button", { name: "Pin to compare" }));
    await waitFor(() => expect(screen.getAllByTestId("plan-panel")).toHaveLength(2));
    expect(panelOf(B2)).toBeTruthy();
    expect(within(brief()).getByRole("button", { name: "Pinned · remove" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Open Haworth in the 3D live view" }));
    const strip = await screen.findByTestId("thumb-strip");
    await waitFor(() => expect(within(strip).getAllByTestId("thumb").map((t) => t.dataset.planId)).toEqual([B2]));
  });

  it("tray × unpins → the brief's pin button", async () => {
    await renderApp([A, B, C], A);
    expect(within(brief()).getByRole("button", { name: "Pinned · remove" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Remove Haworth from the comparison" }));
    await waitFor(() => expect(screen.getAllByTestId("plan-panel")).toHaveLength(2));
    expect(within(brief()).getByRole("button", { name: "Pin to compare" }).getAttribute("aria-pressed")).toBe("false");
  });
});

/* ------------------------------------------------------------------ site */

describe("site", () => {
  it("Moon map pin → plan moves to the same date at that site; sidebar, tray and brief follow", async () => {
    const M = "malapert_massif_20270309_7d";
    await renderApp([A, M], A);
    fireEvent.click(map().getByRole("button", { name: "Malapert Massif" }));
    expect(appStore.getState().selectedSite).toBe("malapert_massif");
    expect(appStore.getState().selectedPlanId).toBe(M); // same arrival, same L
    await stageShows("Malapert Massif");
    expect(sidebar().getByRole("button", { name: /^Haworth/ }).getAttribute("aria-pressed")).toBe("false");
    expect(panelOf(M).className).toContain("selected");
  });

  it("sidebar site row → the Moon map pin and the brief", async () => {
    await renderApp([], A);
    fireEvent.click(sidebar().getByRole("button", { name: /^Nobile Rim 1/ }));
    expect(appStore.getState().selectedPlanId).toBe("nobile_rim_1_20270309_7d");
    await stageShows("Nobile Rim 1");
  });
});

/* ------------------------------------------------------------------ time */

describe("time", () => {
  it("tray scrubber → every panel and the selected plan's mission clock", async () => {
    await renderApp([A, B], A);
    fireEvent.change(screen.getByRole("slider", { name: "Time since arrival (all panels)" }), { target: { value: "30" } });
    for (const p of screen.getAllByTestId("plan-panel")) expect(within(p).getByTestId("silhouette").dataset.sample).toBe("60");
    expect(appStore.getState().missionTime).toBe(arrivalMs(A) + 30 * HOUR);
  });

  it("live mission clock at the site → arrival panorama and thumbnails; back in planning the tray is at the same moment", async () => {
    await renderApp([A, B], A);
    fireEvent.click(screen.getByRole("button", { name: "Open Haworth in the 3D live view" }));
    await screen.findByTestId("mission-controls");
    const traj = await appStore.getState().data.trajectory(plan(A).trajectory_id);
    const tl = timelineOf(plan(A), traj);
    fireEvent.click(screen.getByRole("button", { name: "At the site" }));
    fireEvent.change(screen.getByRole("slider", { name: /mission time/i }), { target: { value: String((tl.landingMs + 20 * HOUR - tl.startMs) / 60_000) } });
    const dock = await screen.findByTestId("live-site");
    await waitFor(() => expect(within(dock).getByTestId("panorama").dataset.sample).toBe("40"));
    expect(screen.getByTestId("thumb-clock").textContent).toBe("Day 1, 20:00");
    const thumb = within(screen.getByTestId("thumb-strip")).getByTestId("thumb");
    await waitFor(() => expect(within(thumb).getByTestId("silhouette").dataset.sample).toBe("40"));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.getAllByTestId("plan-panel")).toHaveLength(2));
    for (const p of screen.getAllByTestId("plan-panel")) await waitFor(() => expect(within(p).getByTestId("silhouette").dataset.sample).toBe("40"));
    expect(appStore.getState().compareTime).toBe(20);
  });

  it("live mission clock before landing (transit) leaves the tray clock alone", async () => {
    await renderApp([A, B], A);
    act(() => appStore.getState().setCompareTime(12));
    fireEvent.click(screen.getByRole("button", { name: "Open Haworth in the 3D live view" }));
    await screen.findByTestId("mission-controls");
    fireEvent.click(screen.getByRole("button", { name: "Transit" }));
    expect(appStore.getState().missionPhase).toBe("transit");
    expect(appStore.getState().compareTime).toBe(12);
  });
});

/* ------------------------------------------------------------------ window length */

describe("window length", () => {
  it("sidebar stay L → same site and arrival with the new L in the sidebar and the brief", async () => {
    await renderApp([], A);
    fireEvent.click(sidebar().getByRole("button", { name: "14 days" }));
    expect(appStore.getState().selectedPlanId).toBe("haworth_20270309_14d");
    expect(sidebar().getByRole("button", { name: "14 days" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(within(brief()).getByText("Day 14")).toBeTruthy());
    await stageShows("Haworth");
  });
});

/* ------------------------------------------------------------------ T5.1.b: the same figures in every view */

describe("same figures in every view (T5.1.b)", () => {
  // two plans whose exact decimals sit on a rounding half (score 0.975, sunlight 68.45) and an ordinary one
  const P = ["connecting_ridge_20270304_7d", "connecting_ridge_20270318_7d", A];

  it("the shared rounding is half up on the decimal value", () => {
    expect(round(0.745, 2)).toBe("0.75");
    expect(round(0.975, 2)).toBe("0.98");
    expect(round(68.45, 1)).toBe("68.5");
    expect(round(43.15, 1)).toBe("43.2");
    expect(round(1, 2)).toBe("1.00");
    expect(round(0.04999, 1)).toBe("0.0");
    expect(num(100)).toBe("100");
    expect(num(68.45)).toBe("68.5");
    expect(fmtMetric("score", 0.975)).toBe("0.98");
  });

  it("3 plans: tray box, ribbon, why text and the site brief agree", async () => {
    await renderApp(P);
    for (const id of P) {
      const rows = await appStore.getState().data.windows(plan(id).site_id, 7);
      const row = rows.rows.find((r) => r.start === plan(id).arrival_utc)!;
      const expected = Object.fromEntries(METRICS.map(({ key }) => [key, fmtMetric(key, row[key])])) as Record<MetricKey, string>;

      // tray: metrics box
      const box = within(panelOf(id)).getByTestId("metrics-box");
      for (const { key } of METRICS) expect(box.querySelector(`[data-metric="${key}"] .metric-value`)!.textContent, `${id} tray ${key}`).toBe(expected[key]);
      // tray: time ribbon's longest dark = the metric
      const ribbonText = within(panelOf(id)).getByText(/Longest dark:|No dark stretch/).textContent!;
      expect(ribbonText, `${id} ribbon`).toBe(row.longest_dark_h === 0 ? "No dark stretch" : `Longest dark: ${expected.longest_dark_h} h`);

      // the planning stage's site brief: sunlight, longest night and the Earth's worst day
      act(() => appStore.getState().selectPlan(id));
      await waitFor(() => expect(within(brief()).getByRole("heading", { level: 2 }).textContent).toBe(plan(id).site_id === "haworth" ? "Haworth" : "Connecting Ridge (Shackleton rim)"));
      await waitFor(() => expect(brief().querySelector(".brief-metrics")).not.toBeNull());
      const dds = [...brief().querySelectorAll(".brief-metrics dd:not(.brief-metric-note)")].map((dd) => dd.textContent);
      expect(dds, `${id} brief`).toEqual([`${expected.sun_pct} %`, `${num(row.longest_dark_h)} h`, `${num(row.earth_h_min)} h`]);

      // why text: every number it quotes is one of the box's figures (same rounding)
      const why = within(panelOf(id)).getByTestId("why").textContent!;
      const quoted = [...why.matchAll(/(\d+(?:\.\d+)?)(?=% sunlight| h| \))|\((\d\.\d\d)\)/g)].map((m) => m[1] ?? m[2]);
      const shown = new Set(Object.values(expected).flatMap((v) => [v, v.replace(/\.0$/, "")]));
      for (const q of quoted) expect(shown.has(q), `${id} why "${why}" quotes ${q}`).toBe(true);
    }
    // the edge cases really are shown rounded half up
    expect(within(panelOf(P[0])).getByTestId("metrics-box").querySelector('[data-metric="score"] .metric-value')!.textContent).toBe("0.98");
    expect(within(panelOf(P[1])).getByTestId("metrics-box").querySelector('[data-metric="sun_pct"] .metric-value')!.textContent).toBe("68.5");
  });

  it("the ribbon's longest dark equals longest_dark_h for every 7-day plan of every site", async () => {
    const st = appStore.getState();
    let n = 0;
    const bad: string[] = [];
    for (const site of st.sites) {
      const rows = (await st.data.windows(site.id, 7)).rows;
      for (const r of rows) {
        const id = `${site.id}_${r.start.slice(0, 10).replace(/-/g, "")}_7d`;
        const pd = await loadPlanData(st.data, plan(id), st.sites);
        const run = longestZeroRun(pd.series.sunVis);
        const h = run ? ((run.end - run.start) * pd.series.stepMin) / 60 : 0;
        if (round(h, 1) !== fmtMetric("longest_dark_h", r.longest_dark_h)) bad.push(`${id}: ribbon ${h} vs ${r.longest_dark_h}`);
        n++;
      }
    }
    console.log(`ribbon vs metric: ${n} plans, ${bad.length} mismatches`);
    expect(bad).toEqual([]);
  }, 60_000);
});
