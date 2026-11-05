// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Compass heading from a DeviceOrientationEvent, in degrees clockwise
 * from true-ish north (what the platform reports), corrected for how
 * the screen is turned. Null when the event carries no usable heading.
 *
 *  - iOS Safari reports `webkitCompassHeading`: already a compass
 *    heading, clockwise from north, for the top of the device.
 *  - Elsewhere (Chrome on Android) an absolute event's `alpha` is the
 *    rotation around the z axis, counter-clockwise from north, so the
 *    heading is 360 - alpha. A relative event (absolute false) has an
 *    alpha measured from wherever the page loaded, which is no
 *    heading at all, so it is refused.
 *
 * The device top only points where the user faces in portrait; in
 * landscape the screen's own rotation is added on.
 */
export interface OrientationLike {
  alpha: number | null;
  absolute?: boolean;
  webkitCompassHeading?: number;
}

export function headingFromOrientation(
  e: OrientationLike,
  screenAngle = 0,
): number | null {
  let h: number;
  if (
    typeof e.webkitCompassHeading === 'number' &&
    Number.isFinite(e.webkitCompassHeading)
  ) {
    h = e.webkitCompassHeading;
  } else if (e.absolute === true && typeof e.alpha === 'number' && Number.isFinite(e.alpha)) {
    h = 360 - e.alpha;
  } else {
    return null;
  }
  return normalizeDegrees(h + (Number.isFinite(screenAngle) ? screenAngle : 0));
}

/** Into [0, 360). */
export function normalizeDegrees(d: number): number {
  const r = d % 360;
  return r < 0 ? r + 360 : r;
}

/** Smallest unsigned angle between two headings, in [0, 180]. */
export function angleBetween(a: number, b: number): number {
  const d = Math.abs(normalizeDegrees(a) - normalizeDegrees(b));
  return d > 180 ? 360 - d : d;
}
