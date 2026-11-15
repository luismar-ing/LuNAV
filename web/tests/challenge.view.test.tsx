// @vitest-environment jsdom
/** C3: the challenge screen ("Can your lander make it?", level 1): the 3D scene and a sidebar to choose the plan. */
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
  await appStore.getState().loadCore();
});
beforeEach(() => {
  appStore.getState().setScreen("landing");
  appStore.getState().selectPlan(null);
});
afterEach(cleanup);

describe("Challenge screen (C3)", () => {
  it("shows the mission, the ASSUMED lander, the sites and the 31 days of March over the 3D scene", async () => {
    render(<App />);
    act(() => appStore.getState().setScreen("challenge"));
    const ch = within(screen.getByTestId("challenge"));
    expect(ch.getByRole("heading", { name: "Can your lander make it?" })).toBeTruthy();
    expect(ch.getByText("ASSUMED")).toBeTruthy();
    expect(ch.getByText(/keep the lander powered for 7 days/)).toBeTruthy();
    expect(within(ch.getByRole("group", { name: "1. Choose a landing site" })).getAllByRole("button")).toHaveLength(5);
    expect(within(ch.getByRole("group", { name: "2. Choose a landing day in March 2027" })).getAllByRole("button")).toHaveLength(31);
    await waitFor(() => expect(screen.getByTestId("scene-host")).toBeTruthy());
  });

  it("the chosen site and day become the mission's plan; the clock waits at the countdown", async () => {
    render(<App />);
    act(() => appStore.getState().setScreen("challenge"));
    fireEvent.click(screen.getByRole("button", { name: "Haworth" }));
    fireEvent.click(screen.getByRole("button", { name: "Mar 10, 2027" }));
    expect(appStore.getState().selectedPlanId).toBe("haworth_20270310_7d");
    fireEvent.click(screen.getByRole("button", { name: "Nobile Rim 1" }));
    expect(appStore.getState().selectedPlanId).toBe("nobile_rim_1_20270310_7d");
    await waitFor(() => expect(appStore.getState().missionPhase).toBe("overview"));
    expect(screen.getByRole("button", { name: "Nobile Rim 1" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("'Launch' flies the mission and plays the stay; it stops where the battery runs empty", async () => {
    render(<App />);
    act(() => appStore.getState().setScreen("challenge"));
    const launch = screen.getByRole("button", { name: "Launch the mission" }) as HTMLButtonElement;
    expect(launch.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Nobile Rim 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Mar 2, 2027" }));
    await waitFor(() => expect(launch.disabled).toBe(false));
    fireEvent.click(launch);

    // the flight: the sidebar gives way to the mission's panel, the battery is full until landing
    const hud = within(screen.getByTestId("challenge-hud"));
    expect(screen.getByTestId("challenge").dataset.stage).toBe("flight");
    expect(hud.getByRole("heading", { name: "Nobile Rim 1" })).toBeTruthy();
    expect(hud.getByRole("meter", { name: "Battery" }).getAttribute("aria-valuenow")).toBe("100");
    fireEvent.click(hud.getByRole("button", { name: "Skip ahead" }));
    // then the descent, slower, from lunar arrival to touchdown
    await waitFor(() => expect(appStore.getState().missionPhase).toBe("landing"));
    expect(screen.getByTestId("challenge").dataset.stage).toBe("flight");
    fireEvent.click(hud.getByRole("button", { name: "Skip ahead" }));

    // the stay: it landed in the dark, so the battery runs empty 20 h after landing (Mar 2, 20:00 UTC)
    await waitFor(() => expect(screen.getByTestId("challenge").dataset.stage).toBe("stay"));
    expect(appStore.getState().missionPhase).toBe("site");
    expect(hud.getByText("Sun hidden by the terrain")).toBeTruthy();
    expect(hud.getByText(/^Draining: the Sun is hidden/)).toBeTruthy();
    fireEvent.click(hud.getByRole("button", { name: "Skip ahead" }));
    await waitFor(() => expect(screen.getByTestId("challenge").dataset.stage).toBe("done"));
    expect(appStore.getState().missionTime).toBe(Date.parse("2027-03-02T20:00:00Z"));
    expect(hud.getByRole("meter", { name: "Battery" }).getAttribute("aria-valuenow")).toBe("0");
    expect(hud.getByText(/^Empty: the lander has no power left/)).toBeTruthy();
    expect(hud.queryByRole("button", { name: "Skip ahead" })).toBeNull();
  });

  it("'Back to the story' returns to the Educator; Esc leaves for the start page", () => {
    render(<App />);
    act(() => appStore.getState().setScreen("challenge"));
    fireEvent.click(screen.getByRole("button", { name: "Back to the story" }));
    expect(appStore.getState().screen).toBe("educator");
    act(() => appStore.getState().setScreen("challenge"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(appStore.getState().screen).toBe("landing");
  });
});
