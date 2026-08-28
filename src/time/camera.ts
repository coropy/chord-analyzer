/**
 * Timeline camera: maps tick ↔ horizontal canvas X and pitch ↔ vertical Y.
 *
 * Top-left origin, y increases downward. `topPitch` = MIDI note at the top edge.
 * Provides both tick→X and the inverse screenX→tick needed for click-to-marker /
 * click-to-seek / quantization. All math explicit and reversible.
 */
export interface Camera {
  /** tick at the left edge (fractional allowed for smooth scroll) */
  scrollTick: number;
  /** pixels per tick (horizontal zoom) */
  pxPerTick: number;
  /** MIDI pitch at the top edge */
  topPitch: number;
  /** pixels per MIDI semitone (vertical zoom) */
  pxPerPitch: number;
}

export interface CameraView extends Camera {
  viewportWidth: number;
  viewportHeight: number;
  /** devicePixelRatio for physical canvas backing stores. */
  dpr?: number;
}

export function makeCamera(init: Partial<Camera> = {}): Camera {
  return {
    scrollTick: init.scrollTick ?? 0,
    pxPerTick: init.pxPerTick ?? 1,
    topPitch: init.topPitch ?? 127,
    pxPerPitch: init.pxPerPitch ?? 8,
  };
}

/** Fit so that [startTick,endTick) fills width and pitch range fills height. */
export function fitCamera(
  width: number, height: number,
  minTick: number, maxTick: number,
  minPitch: number, maxPitch: number,
): CameraView {
  const pxPerTick = width / Math.max(1, maxTick - minTick);
  const pxPerPitch = height / Math.max(1, (maxPitch - minPitch) + 2);
  return {
    scrollTick: minTick,
    pxPerTick,
    topPitch: maxPitch + 1,
    pxPerPitch,
    viewportWidth: width,
    viewportHeight: height,
  };
}

/** Visible tick range [left, right). */
export function viewTickRange(c: CameraView): { leftTick: number; rightTick: number } {
  return {
    leftTick: c.scrollTick,
    rightTick: c.scrollTick + c.viewportWidth / c.pxPerTick,
  };
}

/** tick → pixel X. */
export function tickToX(c: Camera, tick: number): number {
  return (tick - c.scrollTick) * c.pxPerTick;
}

/** pixel X → tick. */
export function xToTick(c: Camera, x: number): number {
  const v = c.scrollTick + x / c.pxPerTick;
  return v < 0 ? 0 : v;
}

/** pitch → pixel Y (higher pitch at top). */
export function pitchToY(c: Camera, pitch: number): number {
  let p = (c.topPitch - pitch) * c.pxPerPitch;
  if (p < 0) p = 0;
  return p;
}

/** pixel Y → MIDI pitch. */
export function yToPitch(c: Camera, y: number): number {
  return c.topPitch - y / c.pxPerPitch;
}

/**
 * Zoom horizontally about a fixed anchor tick (keeps anchor's screen X fixed).
 * Returns a new Camera with updated pxPerTick.
 */
export function zoomTick(
  c: Camera,
  anchorTick: number,
  anchorX: number,
  factor: number,
  clamp?: { minPxPerTick?: number; maxPxPerTick?: number },
): Camera {
  const newPx = c.pxPerTick * factor;
  const px = clamp?.minPxPerTick != null ? Math.max(clamp.minPxPerTick, newPx) : newPx;
  const px2 = clamp?.maxPxPerTick != null ? Math.min(clamp.maxPxPerTick, px) : px;
  // keep anchorTick at anchorX: scrollTick = anchorTick - anchorX/pxPerTick
  const scrollTick = anchorTick - anchorX / px2;
  return { ...c, pxPerTick: px2, scrollTick };
}

/** Zoom vertically around a fixed anchor pitch/y. */
export function zoomPitch(
  c: Camera,
  anchorPitch: number,
  anchorY: number,
  factor: number,
  clamp?: { minPxPerPitch?: number; maxPxPerPitch?: number },
): Camera {
  const newPx = c.pxPerPitch * factor;
  const px = clamp?.minPxPerPitch != null ? Math.max(clamp.minPxPerPitch, newPx) : newPx;
  const px2 = clamp?.maxPxPerPitch != null ? Math.min(clamp.maxPxPerPitch, px) : px;
  const topPitch = anchorPitch + anchorY / px2;
  return { ...c, pxPerPitch: px2, topPitch };
}