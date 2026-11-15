/**
 * Whether the last thing the user did on the page was a key press or a pointer press (B5, B9): what the browser's
 * own :focus-visible heuristic decides, for the places where it cannot help:
 *  - the arrival date field, whose focus lives inside the date input's own segments;
 *  - focus handed back by script (the drawer returns it to the button that opened it), which browsers show as
 *    :focus-visible even when that button was clicked with the mouse (finding H15).
 */
let keyboard = false;

if (typeof document !== "undefined") {
  document.addEventListener("keydown", () => (keyboard = true), true);
  document.addEventListener("pointerdown", () => (keyboard = false), true);
}

export const lastInputWasKeyboard = (): boolean => keyboard;

/**
 * Gives focus back to an element without the focus ring when the user was using the pointer: the element is marked
 * with data-pointer-focus (tokens.css hides the ring for it) until it loses focus. With the keyboard the ring shows.
 */
export function restoreFocus(el: HTMLElement | null | undefined, byPointer: boolean): void {
  if (!el?.focus) return;
  if (byPointer) {
    el.setAttribute("data-pointer-focus", "");
    el.addEventListener("blur", () => el.removeAttribute("data-pointer-focus"), { once: true });
  }
  el.focus();
}
