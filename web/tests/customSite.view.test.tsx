// @vitest-environment jsdom
/** B12 (decision A13): the "Custom coordinates" panel of the Mission Planner, over the real data. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { appStore } from "../src/store/appStore";

vi.mock("../src/scene3d/SceneHost", () => ({ SceneHost: () => <div data-testid="scene-host" /> }));

const REAL = join(__dirname, "..", "public", "data");
const HAS_GRID = existsSync(join(REAL, "horizon_grid", "grid.json"));
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

describe.runIf(HAS_GRID)("Custom coordinates (B12)", () => {
  it("opens on the selected site's coordinates and gives the published numbers back with the site's horizon nearby", async () => {
    const { drawer } = await openPanel();
    const table = await drawer.findByTestId("custom-table", {}, { timeout: 5000 });
    // default plan: Connecting Ridge, Jan 1, 7 days
    const rows = within(table).getAllByRole("row");
    expect(rows[1].textContent).toContain("This point");
    expect(drawer.getByTestId("custom-approx").textContent).toBe("APPROXIMATE");
    expect(drawer.getByTestId("custom-grid-note").textContent).toMatch(/nearest grid point, \d\.\d\d km away/);
    // the five candidate sites are listed for the same arrival and stay
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2 + appStore.getState().sites.length));
    // the panorama of the stay is drawn
    expect(drawer.getByRole("img", { name: /Custom site/ })).toBeTruthy();
  });

  it("analyses a typed coordinate, and says when it is outside the terrain grid", async () => {
    const { drawer } = await openPanel();
    const input = drawer.getByLabelText("Latitude, longitude");
    fireEvent.change(input, { target: { value: "88.5S 45E" } });
    fireEvent.click(drawer.getByRole("button", { name: "Analyse" }));
    await waitFor(() => expect(drawer.getByRole("heading", { name: "Custom site · -88.500°, 45.000°" })).toBeTruthy());

    fireEvent.change(input, { target: { value: "-80, 0" } });
    fireEvent.click(drawer.getByRole("button", { name: "Analyse" }));
    await waitFor(() => expect(drawer.getByText(/Outside the terrain grid/)).toBeTruthy());

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
});
