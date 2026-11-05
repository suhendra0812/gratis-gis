// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useState } from 'react';
import { angleBetween, headingFromOrientation } from '@/lib/device-heading';

type CompassEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };
type OrientationCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

/** Smallest change worth a re-render; the sensor is noisy. */
const MIN_CHANGE_DEG = 1;

/**
 * The device's compass heading, live.
 *
 * iOS (13+) only delivers orientation events after
 * DeviceOrientationEvent.requestPermission() resolves 'granted', and
 * only lets a page ask from inside a user gesture, so `request` must be
 * called straight from a tap handler (the locate and compass buttons
 * do). Everywhere else there is no prompt and listening starts at once.
 *
 * Chrome on Android fires 'deviceorientationabsolute' with a north-
 * referenced alpha; plain 'deviceorientation' there is relative and is
 * not used. Updates are coalesced to one per frame and dropped when
 * the heading moved by less than a degree.
 */
export function useDeviceHeading(): {
  /** Degrees clockwise from north, or null before the first reading. */
  heading: number | null;
  /** Ask for the sensor (iOS prompt). True when it can be listened to. */
  request: () => Promise<boolean>;
} {
  const [heading, setHeading] = useState<number | null>(null);
  const [listening, setListening] = useState(false);

  // No permission gate on this platform: listen right away.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof DeviceOrientationEvent === 'undefined') {
      return;
    }
    const Ctor = DeviceOrientationEvent as OrientationCtor;
    if (typeof Ctor.requestPermission !== 'function') setListening(true);
  }, []);

  const request = useCallback(async (): Promise<boolean> => {
    if (typeof window === 'undefined' || typeof DeviceOrientationEvent === 'undefined') {
      return false;
    }
    const Ctor = DeviceOrientationEvent as OrientationCtor;
    if (typeof Ctor.requestPermission === 'function') {
      try {
        if ((await Ctor.requestPermission()) !== 'granted') return false;
      } catch {
        // Called outside a gesture, or the user said no before.
        return false;
      }
    }
    setListening(true);
    return true;
  }, []);

  useEffect(() => {
    if (!listening) return undefined;
    let frame = 0;
    let pending: number | null = null;
    let last: number | null = null;
    const screenAngle = () => {
      const so = window.screen?.orientation;
      if (so && typeof so.angle === 'number') return so.angle;
      const legacy = (window as unknown as { orientation?: number }).orientation;
      return typeof legacy === 'number' ? legacy : 0;
    };
    const onEvent = (ev: Event) => {
      const h = headingFromOrientation(ev as CompassEvent, screenAngle());
      if (h === null) return;
      pending = h;
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (pending === null) return;
        if (last === null || angleBetween(pending, last) >= MIN_CHANGE_DEG) {
          last = pending;
          setHeading(pending);
        }
      });
    };
    const type =
      'ondeviceorientationabsolute' in window
        ? 'deviceorientationabsolute'
        : 'deviceorientation';
    window.addEventListener(type, onEvent);
    return () => {
      window.removeEventListener(type, onEvent);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [listening]);

  return { heading, request };
}
