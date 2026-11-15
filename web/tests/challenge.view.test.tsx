// @vitest-environment jsdom
/** C3: the challenge screen ("Can your lander make it?", level 1) launches a site + day and explains the result. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { appStore } from "../src/store/appStore";
import { Challenge } from "../src/views/Challenge";

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
afterEach(cleanup);

const days = () => within(screen.getByRole("group", { name: "2. Choose a landing day in March 2027" }));

describe("Challenge screen (C3)", () => {
  it("needs a site and a day before launching", () => {
    render(<Challenge onWatch={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: "Can your lander make it?" })).toBeTruthy();
    expect(screen.getByText("ASSUMED")).toBeTruthy();
    expect(days().getAllByRole("button")).toHaveLength(31);
    expect((screen.getByRole("button", { name: "Launch the mission" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains a lost lander, reveals the site's good days, and a good day can be watched", async () => {
    const onWatch = vi.fn();
    render(<Challenge onWatch={onWatch} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Nobile Rim 1" }));
    fireEvent.click(days().getByRole("button", { name: "Mar 2, 2027" }));
    const launch = screen.getByRole("button", { name: "Launch the mission" }) as HTMLButtonElement;
    await vi.waitFor(() => expect(launch.disabled).toBe(false));
    fireEvent.click(launch);

    const result = screen.getByTestId("challenge-result");
    expect(result.dataset.success).toBe("false");
    expect(within(result).getByText(/Your lander lost power$/)).toBeTruthy();
    expect(screen.getByTestId("challenge-why").textContent).toMatch(
      /^The battery ran empty for [\d.]+ h\. You landed in the middle of a 235\.5 h night: the Sun was already behind the terrain\. A full battery lasts 20 h\.$/,
    );
    expect(screen.queryByRole("button", { name: "Watch your landing" })).toBeNull();

    // the site's month is revealed: 12 of 31 March days keep the lander powered at Nobile Rim 1 (challenge.test.ts)
    const ok = days().getAllByRole("button").filter((b) => b.dataset.outcome === "ok");
    expect(ok).toHaveLength(12);
    expect(days().getByRole("button", { name: "Mar 2, 2027, the lander loses power" })).toBeTruthy();

    // picking another day clears the result; a good day succeeds and can be watched
    fireEvent.click(ok[0]);
    expect(screen.queryByTestId("challenge-result")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Launch the mission" }));
    expect(screen.getByTestId("challenge-result").dataset.success).toBe("true");
    expect(screen.getByText(/^Attempt 2 · Nobile Rim 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Watch your landing" }));
    expect(onWatch).toHaveBeenCalledWith("nobile_rim_1", expect.stringMatching(/^2027-03-\d\d$/));
  });
});
