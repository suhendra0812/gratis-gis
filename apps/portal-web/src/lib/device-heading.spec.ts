// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  angleBetween,
  headingFromOrientation,
  normalizeDegrees,
} from './device-heading';

describe('headingFromOrientation', () => {
  it('uses iOS webkitCompassHeading as is', () => {
    expect(headingFromOrientation({ alpha: 10, webkitCompassHeading: 45 })).toBe(45);
  });

  it('turns an absolute alpha (counter-clockwise) into a clockwise heading', () => {
    expect(headingFromOrientation({ alpha: 90, absolute: true })).toBe(270);
    expect(headingFromOrientation({ alpha: 0, absolute: true })).toBe(0);
  });

  it('refuses a relative alpha, which is not a heading', () => {
    expect(headingFromOrientation({ alpha: 90, absolute: false })).toBeNull();
    expect(headingFromOrientation({ alpha: 90 })).toBeNull();
  });

  it('refuses an event without a reading', () => {
    expect(headingFromOrientation({ alpha: null, absolute: true })).toBeNull();
  });

  it('adds the screen rotation in landscape', () => {
    expect(headingFromOrientation({ alpha: 0, webkitCompassHeading: 350 }, 90)).toBe(80);
  });
});

describe('normalizeDegrees / angleBetween', () => {
  it('wraps into [0, 360)', () => {
    expect(normalizeDegrees(370)).toBe(10);
    expect(normalizeDegrees(-10)).toBe(350);
    expect(normalizeDegrees(360)).toBe(0);
  });

  it('measures across north', () => {
    expect(angleBetween(350, 10)).toBe(20);
    expect(angleBetween(10, 350)).toBe(20);
    expect(angleBetween(90, 270)).toBe(180);
  });
});
