// @vitest-environment jsdom
/**
 * A2: the scale shown in the telemetry belongs to the scene on screen. "Land at …" opens the scene at real local
 * scale; going back to planning unmounts it, and "Launch" must then show "Not to scale" again (it used to keep
 * "Real scale" until the transit).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { appStore } from "../src/store/appStore";

// a scene without WebGL that reports its scale the way the renderer did before A2: only when it differs from
// "space", i.e. when it opens at the site
vi.mock("../src/scene3d/renderer", async () => {
  const { appStore: store } = await import("../src/store/appStore");
  return {
    mountScene: (_el: HTMLElement, opts: { onScaleChange?(s: "space" | "local"): void }) => {
      if (store.getState().missionPhase === "site") opts.onScaleChange?.("local");
      return { unmount() {}, resumeCamera() {}, setPlan() {} };
    },
  };
});

const REAL = join(__dirname, "..", "public", "data");
globalThis.fetch = (async (url: string) => {
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
  window.scrollTo = () => {};
  await appStore.getState().loadCore();
});
afterEach(cleanup);

const telemetryScale = () => screen.getByText("Scale").nextElementSibling?.textContent;

describe("scene scale label (A2)", () => {
  it("Land at → Back to planning → Launch: 'Real scale' at the site, 'Not to scale' for the launch", async () => {
    render(<App />);
    act(() => {
      appStore.getState().setScreen("planner");
      appStore.getState().selectPlan("haworth_20270111_7d");
    });
    fireEvent.click(await screen.findByRole("button", { name: "Land at Haworth" }));
    await waitFor(() => expect(appStore.getState().sceneScale).toBe("local"));
    await waitFor(() => expect(telemetryScale()).toBe("Real scale"));

    fireEvent.click(screen.getByRole("button", { name: /Back to planning/ }));
    expect(appStore.getState().viewMode).not.toBe("live");
    expect(appStore.getState().sceneScale).toBe("space"); // the scene is gone

    fireEvent.click(within(screen.getByTestId("mission-sidebar")).getByRole("button", { name: /^Launch · / }));
    await screen.findByTestId("mission-controls", {}, { timeout: 5000 });
    await waitFor(() => expect(appStore.getState().missionPhase).toBe("launch"));
    expect(telemetryScale()).toBe("Not to scale");
  });
});
