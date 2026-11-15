// @vitest-environment jsdom
/**
 * C3 / B14: the challenge screen ("Can your lander make it?", level 1): the 3D scene and a sidebar to choose the plan.
 * The landing point is any coordinate from 85°S to the pole (B14, decision A15), made a virtual site; the expected days
 * come from that point's own series, through the same rules (lib/challenge.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { LEVEL_1, monthOutcomes, stayTrace } from "../src/lib/challenge";
import { fmtDay } from "../src/lib/format";
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
  const st = appStore.getState();
  st.setScreen("landing");
  st.selectPlan(null);
  for (const c of [...appStore.getState().customSites]) appStore.getState().removeCustomSite(c.id);
});
afterEach(cleanup);

const POINT = "-89.45, -137.1"; // near Connecting Ridge: 19 of the 31 March days keep the power
const POINT_ID = "custom_s894500_w1371000";
const POINT_NAME = "Custom site · -89.450°, -137.100°";

/** Types a coordinate and uses it (the map is the same picker as the planner's custom coordinates). */
function choosePoint(text = POINT) {
  const ch = within(screen.getByTestId("challenge"));
  fireEvent.change(ch.getByLabelText("Latitude, longitude"), { target: { value: text } });
  fireEvent.click(ch.getByRole("button", { name: "Use" }));
}

/** The month at the point, from its own (virtual) series: a day that loses power and one that keeps it. */
async function daysAtPoint() {
  await waitFor(() => expect(appStore.getState().customSite?.id).toBe(POINT_ID), { timeout: 8000 });
  const ts = await appStore.getState().data.timeseries(POINT_ID);
  const outcomes = Object.entries(monthOutcomes(ts, LEVEL_1));
  const bad = outcomes.find(([d, ok]) => !ok && stayTrace(ts, d, LEVEL_1.stayDays)?.powerLostMs != null);
  const good = outcomes.find(([, ok]) => ok);
  expect(bad && good).toBeTruthy(); // the point has both kinds of day in March, so the choice of day matters
  return { ts, bad: bad![0], good: good![0] };
}

const launchButton = () => screen.getByRole("button", { name: "Launch the mission" }) as HTMLButtonElement;
const ready = () => waitFor(() => expect(launchButton().disabled).toBe(false), { timeout: 8000 });

describe("Challenge screen (C3, B14)", () => {
  it("shows the mission, the ASSUMED lander, the Moon map to pick a point and the 31 days of March over the 3D scene", async () => {
    render(<App />);
    act(() => appStore.getState().setScreen("challenge"));
    const ch = within(screen.getByTestId("challenge"));
    expect(ch.getByRole("heading", { name: "Can your lander make it?" })).toBeTruthy();
    expect(ch.getByText("ASSUMED")).toBeTruthy();
    expect(ch.getByText("Keep the lander powered for 7 days. Land anywhere from 85°S, any day in March 2027.")).toBeTruthy();
    expect(ch.getByRole("heading", { name: "1. Choose a landing point on the Moon" })).toBeTruthy();
    expect(await ch.findByTestId("point-picker")).toBeTruthy();
    expect(ch.queryByRole("button", { name: "Haworth" })).toBeNull(); // no preset sites any more
    expect(within(ch.getByRole("group", { name: "2. Choose a landing day in March 2027" })).getAllByRole("button")).toHaveLength(31);
    await waitFor(() => expect(screen.getByTestId("scene-host")).toBeTruthy());
  });

  it("the chosen point and day become the mission's plan; a point outside 85°S or a bad text is refused", async () => {
    render(<App />);
    act(() => appStore.getState().setScreen("challenge"));
    const status = () => screen.getByTestId("challenge-point").textContent;
    choosePoint("-84, 0");
    await waitFor(() => expect(status()).toBe("Outside the terrain data: choose a latitude from 85°S to the pole."), { timeout: 8000 });
    choosePoint("nonsense");
    expect(status()).toBe("Write the latitude and the longitude, e.g. -88.5, 45.");
    choosePoint();
    await waitFor(() => expect(status()).toBe("Landing at -89.450°, -137.100°APPROXIMATE"), { timeout: 8000 });
    expect(screen.getByTestId("challenge-approx").textContent).toBe("APPROXIMATE");
    fireEvent.click(screen.getByRole("button", { name: "Mar 10, 2027" }));
    expect(appStore.getState().selectedPlanId).toBe(`${POINT_ID}_20270310_7d`);
    await waitFor(() => expect(appStore.getState().missionPhase).toBe("overview"));
  });

  it("'Launch' flies the mission and plays the stay; it stops where the battery runs empty", async () => {
    render(<App />);
    act(() => appStore.getState().setScreen("challenge"));
    expect(launchButton().disabled).toBe(true);
    choosePoint();
    const { ts, bad } = await daysAtPoint();
    const lost = stayTrace(ts, bad, LEVEL_1.stayDays)!.powerLostMs!;
    fireEvent.click(screen.getByRole("button", { name: fmtDay(bad) }));
    await ready();
    fireEvent.click(launchButton());

    // the flight: the sidebar gives way to the mission's panel, the battery is full until landing
    const hud = within(screen.getByTestId("challenge-hud"));
    expect(screen.getByTestId("challenge").dataset.stage).toBe("flight");
    expect(hud.getByRole("heading", { name: POINT_NAME })).toBeTruthy();
    expect(hud.getByRole("meter", { name: "Battery" }).getAttribute("aria-valuenow")).toBe("100");
    fireEvent.click(hud.getByRole("button", { name: "Skip ahead" }));
    // then the descent, slower, from lunar arrival to touchdown
    await waitFor(() => expect(appStore.getState().missionPhase).toBe("landing"));
    expect(screen.getByTestId("challenge").dataset.stage).toBe("flight");
    fireEvent.click(hud.getByRole("button", { name: "Skip ahead" }));

    // the stay, with its bar and the time controls (3 h/s by default during the stay)
    await waitFor(() => expect(screen.getByTestId("challenge").dataset.stage).toBe("stay"));
    expect(appStore.getState().missionPhase).toBe("site");
    expect(hud.getByRole("img", { name: /^Stay progress: day \d of 7, \d+% of the way to the goal$/ })).toBeTruthy();
    expect(hud.getByText("Day 7 · goal")).toBeTruthy();
    expect(hud.getByRole("button", { name: "3 h/s" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(hud.getByRole("button", { name: "Pause" }));
    const paused = appStore.getState().missionTime;
    await new Promise((r) => setTimeout(r, 150));
    expect(appStore.getState().missionTime).toBe(paused);
    fireEvent.click(hud.getByRole("button", { name: "Resume" }));
    // the rest of the stay is skipped: it stops exactly where the point's night empties the ASSUMED battery
    fireEvent.click(hud.getByRole("button", { name: "Skip ahead" }));
    await waitFor(() => expect(screen.getByTestId("challenge").dataset.stage).toBe("done"));
    expect(appStore.getState().missionTime).toBe(lost);

    expect(screen.queryByTestId("challenge-hud")).toBeNull();
    expect(screen.getByText(/^Power lost · /)).toBeTruthy();
    const result = within(screen.getByTestId("challenge-result"));
    expect(screen.getByTestId("challenge-result").dataset.success).toBe("false");
    expect(result.getByText(`Attempt 1 · ${POINT_NAME} · landing ${fmtDay(bad)}`)).toBeTruthy();
    expect(result.getByText(/Your lander lost power$/)).toBeTruthy();
    expect(screen.getByTestId("challenge-why").textContent).toMatch(/^The battery ran empty for [\d.]+ h\. .*A full battery lasts 20 h\.$/);
  }, 20000);

  it("'Try again' marks only the day tried; a good day succeeds; 'Watch again' replays; 'Main menu' leaves", async () => {
    render(<App />);
    act(() => appStore.getState().setScreen("challenge"));
    const toEnd = async () => {
      for (const stage of ["flight", "flight", "stay"]) {
        await waitFor(() => expect(screen.getByRole("button", { name: "Skip ahead" })).toBeTruthy());
        expect(screen.getByTestId("challenge").dataset.stage).toBe(stage);
        fireEvent.click(screen.getByRole("button", { name: "Skip ahead" }));
      }
      await waitFor(() => expect(screen.getByTestId("challenge").dataset.stage).toBe("done"));
    };
    const finish = async () => {
      fireEvent.click(launchButton());
      await toEnd();
    };

    choosePoint();
    const { bad, good } = await daysAtPoint();
    fireEvent.click(screen.getByRole("button", { name: fmtDay(bad) }));
    await ready();
    await finish();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    // back at the pad: only the day tried is marked, the other 30 stay unknown
    expect(screen.getByTestId("challenge").dataset.stage).toBe("pick");
    expect(appStore.getState().missionPhase).toBe("overview");
    const days = within(screen.getByRole("group", { name: "2. Choose a landing day in March 2027" })).getAllByRole("button");
    expect(days.filter((b) => b.dataset.outcome !== undefined).map((b) => b.getAttribute("aria-label"))).toEqual([`${fmtDay(bad)}, the lander loses power`]);

    fireEvent.click(screen.getByRole("button", { name: fmtDay(good) }));
    await ready();
    await finish();
    expect(screen.getByTestId("challenge-result").dataset.success).toBe("true");
    expect(screen.getByText(`Attempt 2 · ${POINT_NAME} · landing ${fmtDay(good)}`)).toBeTruthy();
    expect(screen.getByText(/Mission success$/)).toBeTruthy();
    expect(screen.queryByText(/^Power lost/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Watch again" }));
    expect(screen.getByTestId("challenge").dataset.stage).toBe("flight");
    expect(appStore.getState().missionPhase).toBe("launch");
    await toEnd();
    expect(screen.getByText(/^Attempt 2 · /)).toBeTruthy(); // a replay is not a new attempt

    fireEvent.click(screen.getByRole("button", { name: "Main menu" }));
    expect(appStore.getState().screen).toBe("landing");
  }, 20000);

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
