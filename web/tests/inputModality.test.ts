// @vitest-environment jsdom
/** B9 (finding H15): focus handed back after a mouse action does not show the ring; after the keyboard it does. */
import { describe, expect, it } from "vitest";
import { lastInputWasKeyboard, restoreFocus } from "../src/lib/inputModality";

describe("input modality (B9)", () => {
  it("follows the last key press or pointer press on the page", () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(lastInputWasKeyboard()).toBe(true);
    document.dispatchEvent(new Event("pointerdown"));
    expect(lastInputWasKeyboard()).toBe(false);
  });

  it("restores focus without the ring after the mouse, until the element loses focus", () => {
    const a = document.body.appendChild(document.createElement("button"));
    const b = document.body.appendChild(document.createElement("button"));
    restoreFocus(a, true);
    expect(document.activeElement).toBe(a);
    expect(a.hasAttribute("data-pointer-focus")).toBe(true);
    b.focus(); // moving on (Tab) brings the ring back
    expect(a.hasAttribute("data-pointer-focus")).toBe(false);
  });

  it("keeps the ring after the keyboard", () => {
    const a = document.body.appendChild(document.createElement("button"));
    restoreFocus(a, false);
    expect(document.activeElement).toBe(a);
    expect(a.hasAttribute("data-pointer-focus")).toBe(false);
  });
});
