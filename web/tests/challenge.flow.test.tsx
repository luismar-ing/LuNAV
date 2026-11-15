// @vitest-environment jsdom
/** C3: the Educator's last chapter opens the challenge screen. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("Challenge from the Educator (C3)", () => {
  it("'Take the challenge' in chapter 4 opens the challenge screen", async () => {
    render(<App />);
    act(() => appStore.getState().setScreen("educator"));
    await waitFor(() => expect(appStore.getState().selectedPlanId).not.toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Begin the journey" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip ahead" }));
    fireEvent.click(screen.getByRole("button", { name: "Next chapter" })); // landing
    fireEvent.click(screen.getByRole("button", { name: "Next chapter" })); // surface
    expect(screen.getByRole("heading", { name: "On the surface" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Take the challenge" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Take the challenge" }));
    expect(appStore.getState().screen).toBe("challenge");
    expect(screen.getByTestId("challenge")).toBeTruthy();
    expect(screen.queryByTestId("educator")).toBeNull();
  });
});
