// @vitest-environment jsdom
/** C3b: a plan chosen while the 3D scene is still loading reaches the scene once it is ready. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sceneBridge } from "../src/scene3d/bridge";
import { appStore } from "../src/store/appStore";
import { useScenePlan } from "../src/views/useScenePlan";

const REAL = join(__dirname, "..", "public", "data");
beforeAll(async () => {
  globalThis.fetch = (async (url: string) => {
    try {
      return new Response(readFileSync(join(REAL, url.replace(/^.*\/data\//, ""))), { status: 200 });
    } catch {
      return new Response("", { status: 404 });
    }
  }) as typeof fetch;
  await appStore.getState().loadCore();
});
afterEach(() => {
  sceneBridge.setPlan = null;
});

describe("useScenePlan", () => {
  it("hands a plan chosen while the scene loads to the scene once it is ready", async () => {
    appStore.getState().selectPlan("connecting_ridge_20270101_7d"); // the plan the scene starts with
    sceneBridge.setPlan = null; // still loading
    const plan = appStore.getState().plansById.get("haworth_20270310_7d")!;
    const { result } = renderHook(() => useScenePlan(plan));
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current!.landingMs).toBe(Date.parse("2027-03-10T00:00:00Z"));

    const setPlan = vi.fn();
    sceneBridge.setPlan = setPlan; // the scene is ready now
    await waitFor(() => expect(setPlan).toHaveBeenCalledTimes(1));
    expect(setPlan.mock.calls[0][0]).toMatchObject({ siteId: "haworth", timeline: result.current });
  });

  it("does not hand the scene the plan it already shows", async () => {
    appStore.getState().selectPlan("haworth_20270310_7d");
    const setPlan = vi.fn();
    sceneBridge.setPlan = setPlan;
    const plan = appStore.getState().plansById.get("haworth_20270310_7d")!;
    const { result } = renderHook(() => useScenePlan(plan));
    await waitFor(() => expect(result.current).not.toBeNull());
    await new Promise((r) => setTimeout(r, 250));
    expect(setPlan).not.toHaveBeenCalled();
  });
});
