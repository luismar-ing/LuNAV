// @vitest-environment jsdom
/** C3b: "Hide text" clears the caption off the middle of the 3D scene; the title, buttons and ILLUSTRATIVE stay. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { appStore } from "../src/store/appStore";

vi.mock("../src/scene3d/SceneHost", () => ({ SceneHost: () => <div data-testid="scene-host" /> }));

const REAL = join(__dirname, "..", "public", "data");
beforeAll(async () => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.fetch = (async (url: string) => {
    try {
      return new Response(readFileSync(join(REAL, url.replace(/^.*\/data\//, ""))), { status: 200 });
    } catch {
      return new Response("", { status: 404 });
    }
  }) as typeof fetch;
  await appStore.getState().loadCore();
});
beforeEach(() => {
  appStore.getState().setScreen("landing");
  appStore.getState().selectPlan(null);
});
afterEach(cleanup);

describe("Educator 'Hide text' (C3b)", () => {
  it("hides the caption of chapters 2 to 4 and brings it back", async () => {
    render(<App />);
    act(() => appStore.getState().setScreen("educator"));
    await waitFor(() => expect(appStore.getState().selectedPlanId).not.toBeNull());
    // chapter 1 keeps its text: there is no button there
    expect(screen.queryByRole("button", { name: "Hide text" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Begin the journey" }));

    const caption = /days of coasting/;
    expect(screen.getByRole("heading", { name: "The journey" })).toBeTruthy();
    expect(screen.getByText(caption)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide text" }));
    expect(screen.queryByText(caption)).toBeNull();
    expect(screen.getByRole("heading", { name: "The journey" })).toBeTruthy(); // the chapter title stays
    expect(screen.getByText("Chapter 2 of 4")).toBeTruthy();
    expect(screen.getByText("ILLUSTRATIVE")).toBeTruthy(); // what is not real stays labelled
    expect(screen.getByRole("button", { name: "Next chapter" })).toBeTruthy();

    // the choice holds from chapter to chapter, and "Show text" brings it back
    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }));
    const landingCaption = /Near the south pole the Sun never climbs high/;
    expect(screen.getByRole("heading", { name: "Landing" })).toBeTruthy();
    expect(screen.queryByText(landingCaption)).toBeNull();
    const show = screen.getByRole("button", { name: "Show text" });
    expect(show.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(show);
    expect(screen.getByText(landingCaption)).toBeTruthy();
  });
});
