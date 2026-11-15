/**
 * A3: camera input that feels continuous with a mouse wheel, a touchpad and a pinch. The wheel zoom is
 * proportional to the scroll (a touchpad sends many small deltas, a mouse a few large ones), the zoom eases in
 * over a few frames, and a drag released in motion coasts to a stop. With reduced motion everything applies at once.
 * Zoom amounts are in log space: +0.1 moves the camera away by ×e^0.1, −0.1 brings it closer by the same ratio.
 */

const LINE_PX = 16; // deltaMode 1 (lines)
const PAGE_PX = 800; // deltaMode 2 (pages)
/** Log-zoom per pixel of scroll: one mouse-wheel notch (~100 px) ≈ ×1.13, close to the old fixed ×1.1. */
export const SCROLL_K = 0.0012;
/** A pinch (ctrlKey + wheel) sends small deltas (a few px): ×1.1 per 10 px. */
export const PINCH_K = 0.01;
/** At most ×1.35 per event, whatever the device sends. */
export const MAX_STEP = 0.3;
/** The zoom still to apply halves about every 60 ms (time constant 90 ms). */
export const ZOOM_TAU_MS = 90;
/** A released spin loses 63 % of its speed every 160 ms: a flick turns on a little, then stops. */
export const SPIN_TAU_MS = 160;
/** Holding still this long before letting go means "stop here": no coasting. */
export const HOLD_MS = 80;

/** Log-zoom of one wheel event (> 0: away from the target). */
export function wheelZoom(e: Pick<WheelEvent, "deltaY" | "deltaMode" | "ctrlKey">): number {
  const px = e.deltaY * (e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? PAGE_PX : 1);
  return Math.max(-MAX_STEP, Math.min(MAX_STEP, px * (e.ctrlKey ? PINCH_K : SCROLL_K)));
}

export interface MotionStep {
  zoom: number; // log-zoom to apply this frame
  yaw: number; // rad
  pitch: number; // rad
}

/** Zoom easing and drag inertia, advanced once per frame by the render loop. */
export class CameraMotion {
  private zoomPending = 0;
  private vYaw = 0; // rad per ms
  private vPitch = 0;
  private lastMoveMs = 0;
  private coasting = false;

  addZoom(log: number): void {
    this.zoomPending += log;
  }

  /** Pointer down: a held camera does not coast. */
  grab(): void {
    this.coasting = false;
    this.vYaw = this.vPitch = 0;
  }

  /** A drag step, applied by the caller at once: only its speed is kept, smoothed, for the release. */
  track(dYaw: number, dPitch: number, nowMs: number): void {
    const dt = nowMs - this.lastMoveMs;
    this.lastMoveMs = nowMs;
    if (dt <= 0 || dt > 100) return; // first move, or after a pause: no speed to measure yet
    this.vYaw = 0.5 * (dYaw / dt) + 0.5 * this.vYaw;
    this.vPitch = 0.5 * (dPitch / dt) + 0.5 * this.vPitch;
  }

  /** Pointer up: coast on with the last speed, unless the pointer had stopped. */
  release(nowMs: number): void {
    this.coasting = nowMs - this.lastMoveMs < HOLD_MS && (this.vYaw !== 0 || this.vPitch !== 0);
  }

  /** Drop any pending zoom and spin (the guided camera takes over, or a new plan). */
  stop(): void {
    this.zoomPending = 0;
    this.grab();
  }

  get idle(): boolean {
    return this.zoomPending === 0 && !this.coasting;
  }

  step(dtMs: number, reduced: boolean): MotionStep {
    const out: MotionStep = { zoom: 0, yaw: 0, pitch: 0 };
    if (reduced) {
      out.zoom = this.zoomPending;
      this.stop();
      return out;
    }
    if (this.zoomPending !== 0) {
      const f = 1 - Math.exp(-dtMs / ZOOM_TAU_MS);
      out.zoom = this.zoomPending * f;
      this.zoomPending -= out.zoom;
      if (Math.abs(this.zoomPending) < 1e-4) {
        out.zoom += this.zoomPending;
        this.zoomPending = 0;
      }
    }
    if (this.coasting) {
      out.yaw = this.vYaw * dtMs;
      out.pitch = this.vPitch * dtMs;
      const decay = Math.exp(-dtMs / SPIN_TAU_MS);
      this.vYaw *= decay;
      this.vPitch *= decay;
      if (Math.hypot(this.vYaw, this.vPitch) < 2e-6) {
        this.coasting = false;
        this.vYaw = this.vPitch = 0;
      }
    }
    return out;
  }
}
