/**
 * Viewport math, separated from the browser lifecycle.
 *
 * The session manager probes the real window and calls these pure helpers;
 * the fit itself (drift test, ratio calibration, width clamp) is unit-testable
 * without a browser.
 */

import type { ViewportPreset } from "./turn.ts";

export const VIEWPORT_PRESETS: Record<ViewportPreset, { readonly width: number; readonly height: number }> = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

/** The browser chrome (borders + scrollbar) the automation viewport leaves out. */
export const VIEWPORT_CHROME_PX = 16;

/** Width below which a fitted viewport is not useful. */
export const MIN_VIEWPORT_WIDTH = 320;

/** Probe size used to learn the requested→CSS pixel ratio. */
export const RATIO_PROBE = { width: 800, height: 600 } as const;

export interface ViewportGeometry {
  readonly outerW: number;
  readonly innerW: number;
}

export interface ResolvedViewport {
  readonly width: number;
  readonly height: number;
}

/** True when the live window and the automation viewport have drifted apart. */
export function viewportDrifted(geometry: ViewportGeometry): boolean {
  return Math.abs(geometry.innerW - (geometry.outerW - VIEWPORT_CHROME_PX)) > 20;
}

/** Requested→CSS pixel ratio from the calibration probe. */
export function calibratedRatio(probeInnerWidth: number): number | null {
  if (!Number.isFinite(probeInnerWidth) || probeInnerWidth <= 0) return null;
  return RATIO_PROBE.width / probeInnerWidth;
}

/** Viewport width that fills the live window at the calibrated ratio. */
export function fittedWidth(outerW: number, ratio: number): number {
  return Math.max(MIN_VIEWPORT_WIDTH, Math.round((outerW - VIEWPORT_CHROME_PX) * ratio));
}

/**
 * Resolve an explicit viewport request. Returns null for a bare call, which
 * means "release the pin and re-sync to the live window".
 */
export function resolveViewport(input: {
  readonly preset?: ViewportPreset;
  readonly width?: number;
  readonly height?: number;
}): ResolvedViewport | null {
  if (input.preset !== undefined) return VIEWPORT_PRESETS[input.preset];
  if (input.width !== undefined && input.height !== undefined) {
    return { width: input.width, height: input.height };
  }
  return null;
}
