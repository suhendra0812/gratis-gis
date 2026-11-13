// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * The one terra-draw integration, shared by the editor runtime and the
 * map builder.
 *
 * Before this module the editor runtime carried the whole thing inline
 * across five effects and seven structurally-typed casts of a
 * `useRef<unknown>`, and the geo-boundary editor had grown a second
 * copy with different precision and no snapping. Giving the map builder
 * map-builder geometry editing would have made three. This is the extraction
 * the editor's own comments kept deferring, done once so the next
 * surface that wants to move a vertex mounts a hook rather than
 * copying 400 lines.
 *
 * Two hooks:
 *
 *  - `useTerraDraw(map, { snapping })` owns the instance: dynamic
 *    import (the bundle stays small for every page that never edits),
 *    adapter on the SAME MapLibre instance the canvas created, the four
 *    modes, the permissive id strategy, snapping kept in sync, and
 *    teardown. It does NOT call `start()`: an inert terra-draw does not
 *    intercept the canvas's own click handlers, and a started one
 *    contends with MapCanvas's select tool for every click. Callers
 *    start it when a write tool activates.
 *
 *  - `useGeometryEdit(draw, edit)` runs one feature's vertex-editing
 *    session: normalise the geometry to the adapter's precision, push
 *    it into the store with the right mode profile, select it so the
 *    handles render, track every drag through 'change', and remove it
 *    on exit. Returns the live geometry and whether it differs from the
 *    original; persisting is the caller's job, because the two callers
 *    persist differently (the editor sends `x-editor-id`, the builder
 *    relies on the layer share alone).
 *
 * What stays in the callers on purpose: feature-id resolution from a
 * map click (the editor keys on synthesised `gg:` source ids, the
 * builder on `source.kind === 'data-layer'`), the repaint after a save
 * (the editor bumps a geojson-url cache-buster, the builder calls
 * `refreshLayerSource`), undo/redo, templates, and the attribute form.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type * as maplibregl from 'maplibre-gl';
import type { TerraDraw } from 'terra-draw';
import { MapFeatureSnapper, type SnapMap } from '@/lib/map-snap';
import { clientUuid } from '@/lib/uuid';

/**
 * Decimal places terra-draw enforces on every coordinate. Has to match
 * the `coordinatePrecision` handed to the adapter; both read this so
 * they cannot drift. Nine digits is roughly 0.1 mm at the equator.
 *
 * Mandatory, not cosmetic: terra-draw's precision validator runs on
 * every `addFeatures`, and PostGIS returns full doubles (15-ish digits),
 * so a feature loaded from the server is rejected until it has been
 * through `roundCoordsToPrecision`.
 */
export const DRAW_COORD_PRECISION = 9;

/** Geometry families the draw modes map onto (feature edit + markup). */
export type DrawGeometryType = 'point' | 'line' | 'polygon';

/**
 * Markup-only authoring tools. Circle uses terra-draw's circle mode;
 * arrow / text reuse line / point modes and stamp a different
 * DrawingFeature.kind for rendering.
 */
export type MarkupDrawTool = DrawGeometryType | 'circle' | 'arrow' | 'text';

/** terra-draw mode names this module registers. */
export type DrawMode =
  | 'select'
  | 'point'
  | 'linestring'
  | 'polygon'
  | 'circle';

export function drawModeFor(
  geometryType: DrawGeometryType | MarkupDrawTool,
): DrawMode {
  if (geometryType === 'line' || geometryType === 'arrow') return 'linestring';
  if (geometryType === 'text') return 'point';
  if (geometryType === 'circle') return 'circle';
  return geometryType;
}

/**
 * Round every coordinate in a geometry to `precision` places, returning
 * a fresh structure. See DRAW_COORD_PRECISION for why this exists.
 */
export function roundCoordsToPrecision(
  geom: GeoJSON.Geometry,
  precision: number = DRAW_COORD_PRECISION,
): GeoJSON.Geometry {
  const factor = Math.pow(10, precision);
  const r = (n: number) => Math.round(n * factor) / factor;
  const rPos = (p: GeoJSON.Position): GeoJSON.Position =>
    p.length === 2
      ? [r(p[0]!), r(p[1]!)]
      : (p.map((v) => r(v)) as GeoJSON.Position);
  switch (geom.type) {
    case 'Point':
      return { type: 'Point', coordinates: rPos(geom.coordinates) };
    case 'MultiPoint':
      return { type: 'MultiPoint', coordinates: geom.coordinates.map(rPos) };
    case 'LineString':
      return { type: 'LineString', coordinates: geom.coordinates.map(rPos) };
    case 'MultiLineString':
      return {
        type: 'MultiLineString',
        coordinates: geom.coordinates.map((line) => line.map(rPos)),
      };
    case 'Polygon':
      return {
        type: 'Polygon',
        coordinates: geom.coordinates.map((ring) => ring.map(rPos)),
      };
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: geom.coordinates.map((poly) =>
          poly.map((ring) => ring.map(rPos)),
        ),
      };
    case 'GeometryCollection':
      return {
        type: 'GeometryCollection',
        geometries: geom.geometries.map((g) =>
          roundCoordsToPrecision(g, precision),
        ),
      };
  }
}

/**
 * The select-mode flag profile, in one place. It used to be duplicated
 * verbatim between construction and the runtime snapping toggle, which
 * is the kind of pair that drifts the first time someone edits one.
 *
 *   - point: drag the whole feature; a point IS its vertex.
 *   - linestring / polygon: drag the feature, drag vertices, click
 *     midpoints to insert, alt-click a vertex to delete.
 *   - snappable: snap while dragging a vertex, when snapping is on.
 */
function selectFlags(snapping: boolean, toCustom?: SnapToMap) {
  const coordinates = {
    midpoints: true,
    draggable: true,
    deletable: true,
    snappable: snapping
      ? { toLine: true, toCoordinate: true, ...(toCustom ? { toCustom } : {}) }
      : false,
  };
  return {
    point: { feature: { draggable: true } },
    linestring: { feature: { draggable: true, coordinates } },
    polygon: { feature: { draggable: true, coordinates } },
    // Circles are materialised as polygons; allow the same vertex
    // handles so a reviewer can nudge the outline after place.
    circle: { feature: { draggable: true, coordinates } },
  };
}

/** terra-draw `snapping.toCustom`, here always a MapFeatureSnapper. */
type SnapToMap = MapFeatureSnapper['snap'];

/**
 * With `toCustom` the map snapper draws its own markers, so terra-draw's
 * snapping point is turned off rather than drawn twice.
 */
function drawSnapping(snapping: boolean, toCustom?: SnapToMap) {
  if (!snapping) return undefined;
  return toCustom
    ? { toLine: true, toCoordinate: true, toCustom, showSnappingPoint: false }
    : { toLine: true, toCoordinate: true };
}

/** A point has no line to snap to: coordinates and the map only. */
function pointSnapping(snapping: boolean, toCustom?: SnapToMap) {
  if (!snapping || !toCustom) return undefined;
  return { toCoordinate: true, toCustom, showSnappingPoint: false };
}

export interface UseTerraDrawOptions {
  /** Snap to existing vertices and lines while drawing or dragging. */
  snapping: boolean;
  /**
   * Also snap to the features the map's own layers draw, on any layer,
   * and mark what snapped (see MapFeatureSnapper). Off for surfaces
   * that only edit their own sketch.
   */
  snapToMap?: boolean;
}

/**
 * Own a terra-draw instance on `map`. `draw` is null until the dynamic
 * import resolves; `ready` flips when it does, so an effect that must
 * act on the instance can list `ready` in its deps instead of hoping
 * the import beat it (the inline version had exactly that race: a tool
 * activated before the import resolved was silently ignored).
 */
export function useTerraDraw(
  map: maplibregl.Map | null,
  options: UseTerraDrawOptions,
): { draw: TerraDraw | null; ready: boolean } {
  const drawRef = useRef<TerraDraw | null>(null);
  const [ready, setReady] = useState(false);
  // Read at construction time only; runtime changes go through the
  // updateModeOptions effect below. A ref so the setup effect does not
  // rebuild the instance when the toggle flips.
  const snappingRef = useRef(options.snapping);
  snappingRef.current = options.snapping;
  const snapToMap = options.snapToMap === true;
  const snapperRef = useRef<MapFeatureSnapper | null>(null);

  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      const td = await import('terra-draw');
      const adapterMod = await import('terra-draw-maplibre-gl-adapter');
      if (cancelled) return;
      const snapping = snappingRef.current;
      const snapper = snapToMap
        ? new MapFeatureSnapper(map as unknown as SnapMap, DRAW_COORD_PRECISION)
        : null;
      snapperRef.current = snapper;
      const custom = snapper?.snap;
      const snapInit = drawSnapping(snapping, custom);
      const pointInit = pointSnapping(snapping, custom);
      const draw = new td.TerraDraw({
        adapter: new adapterMod.TerraDrawMapLibreGLAdapter({
          map,
          coordinatePrecision: DRAW_COORD_PRECISION,
        }),
        // Permissive id strategy. terra-draw's default validator wants
        // every id UUIDv4-shaped; the geometry-edit flow pushes the
        // server's feature id into the store, and that id's format is
        // not guaranteed across historical and engine-issued rows. Any
        // non-empty string or number is accepted. getId still mints a
        // real UUID for features terra-draw creates itself.
        idStrategy: {
          isValidId: (id) =>
            (typeof id === 'string' && id.length > 0) ||
            typeof id === 'number',
          getId: () => clientUuid(),
        },
        modes: [
          new td.TerraDrawPointMode(pointInit ? { snapping: pointInit } : undefined),
          new td.TerraDrawLineStringMode(
            snapInit ? { snapping: snapInit } : undefined,
          ),
          new td.TerraDrawPolygonMode(
            snapInit ? { snapping: snapInit } : undefined,
          ),
          // 32 segments matches shared-types DrawingFeature docs
          // (circle materialised as a polygon on finish).
          new td.TerraDrawCircleMode({ segments: 32 }),
          new td.TerraDrawSelectMode({ flags: selectFlags(snapping, custom) }),
        ],
      });
      drawRef.current = draw;
      setReady(true);

      // Keep the "landed on a snap" markers in step with the store, and
      // end the session's markers once nothing is being drawn or edited.
      const readSnapshot = () => {
        try {
          return draw.getSnapshot() as Array<{
            id?: string | number;
            geometry: GeoJSON.Geometry;
            properties: Record<string, unknown>;
          }>;
        } catch {
          return []; // not started
        }
      };
      // A point is dragged whole, and terra-draw only snaps coordinate
      // drags (line and polygon vertices); it also emits no `finish`
      // for a feature drag. So a dragged point is checked here: markers
      // while it moves, and on pointer release it is moved onto the
      // snap.
      let draggingPointId: string | number | null = null;
      const draggedPoint = (id: string | number) => {
        if (!snappingRef.current || draw.getMode() !== 'select') return null;
        const f = readSnapshot().find((x) => String(x.id) === String(id));
        if (!f || f.geometry.type !== 'Point' || f.properties.mode === 'select') {
          return null;
        }
        const p = map.project(f.geometry.coordinates as [number, number]);
        return { id: f.id!, event: { containerX: p.x, containerY: p.y } };
      };
      const onChange = (
        ids: Array<string | number> = [],
        type?: string,
        context?: object,
      ) => {
        if (!snapper) return;
        const snapshot = readSnapshot();
        if (snapshot.length === 0) {
          snapper.reset();
          return;
        }
        const fromApi = !!context && 'origin' in context && context.origin === 'api';
        if (type === 'update' && !fromApi) {
          for (const id of ids) {
            const d = draggedPoint(id);
            if (d) {
              draggingPointId = d.id;
              snapper.snap(d.event, { currentId: d.id });
            }
          }
        }
        snapper.refreshPlaced(snapshot);
      };
      const onRelease = () => {
        const id = draggingPointId;
        draggingPointId = null;
        if (!snapper || id === null) return;
        // After terra-draw has ended its own drag on the same release.
        setTimeout(() => {
          const d = draggedPoint(id);
          const c = d ? snapper.snap(d.event, { currentId: d.id }) : undefined;
          if (d && c) {
            try {
              draw.updateFeatureGeometry(d.id, { type: 'Point', coordinates: c });
            } catch {
              /* the feature went away meanwhile */
            }
          }
          snapper.clearLive();
          onChange();
        }, 0);
      };
      const onFinish = () => onChange();
      const onLeave = () => snapper?.clearLive();
      if (snapper) {
        draw.on('change', onChange);
        draw.on('finish', onFinish);
        map.on('mouseout', onLeave);
        map.on('mouseup', onRelease);
        map.on('touchend', onRelease);
      }

      cleanup = () => {
        if (snapper) {
          try {
            draw.off('change', onChange);
            draw.off('finish', onFinish);
          } catch {
            /* already torn down */
          }
          map.off('mouseout', onLeave);
          map.off('mouseup', onRelease);
          map.off('touchend', onRelease);
          snapper.dispose();
          snapperRef.current = null;
        }
        try {
          draw.stop();
        } catch {
          /* terra-draw throws if it was never started; that is fine */
        }
        drawRef.current = null;
        setReady(false);
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
    // snapToMap is fixed per call site; it is read once, like the map.
  }, [map]);

  // Runtime snapping toggle. Each call is wrapped separately because a
  // mode that is not registered throws, and a missing linestring mode
  // must not stop the polygon and select updates from landing.
  useEffect(() => {
    const draw = drawRef.current;
    if (!draw || !ready) return;
    const snapper = snapperRef.current;
    const custom = snapper?.snap;
    const snap = drawSnapping(options.snapping, custom);
    for (const mode of ['linestring', 'polygon'] as const) {
      try {
        draw.updateModeOptions(mode, { snapping: snap });
      } catch {
        /* mode not registered on this build */
      }
    }
    if (custom) {
      try {
        // An empty object switches point snapping off again.
        draw.updateModeOptions('point', {
          snapping: pointSnapping(options.snapping, custom) ?? {},
        });
      } catch {
        /* same */
      }
    }
    try {
      draw.updateModeOptions('select', {
        flags: selectFlags(options.snapping, custom),
      });
    } catch {
      /* same */
    }
    // Turning snapping off clears its markers with it.
    if (!options.snapping) snapper?.reset();
  }, [options.snapping, ready]);

  return { draw: ready ? drawRef.current : null, ready };
}

/** Safe wrappers: terra-draw throws on start-twice and on stop-before-start. */
export function startDraw(draw: TerraDraw | null): void {
  if (!draw) return;
  try {
    draw.start();
  } catch {
    /* already started */
  }
}

export function setDrawMode(draw: TerraDraw | null, mode: DrawMode): void {
  if (!draw) return;
  try {
    draw.setMode(mode);
  } catch {
    /* not started yet */
  }
}

/** One feature's vertex-editing session. */
export interface GeometryEditRequest {
  /**
   * Distinguishes two edits of the same feature id, so a session keyed
   * on this restarts cleanly. The editor uses its target key, the map
   * builder its map-layer id.
   */
  key: string;
  featureId: string;
  geometryType: DrawGeometryType;
  /** As read from the server; rounded to precision before loading. */
  geometry: GeoJSON.Geometry;
}

export interface GeometryEditState {
  /** The geometry as it is right now, after every drag so far. */
  currentGeometry: GeoJSON.Geometry | null;
  /** True once the current geometry differs from what was loaded. */
  dirty: boolean;
  /** Why the feature could not be loaded into the editor, if it could not. */
  loadError: string | null;
}

/**
 * Drive a geometry edit on `draw` for as long as `edit` is non-null.
 *
 * On entry: start, switch to select, push the feature into the store
 * with `properties.mode` set to its geometry family (that is how
 * terra-draw picks the flag profile), and select it so the handles
 * render. The original stays painted on the underlying layer; the
 * editable copy sits on top with handles, which is enough to say
 * "this one" without a transient layer filter.
 *
 * While active: every 'change' that names this feature reads the
 * latest geometry off the snapshot.
 *
 * On exit, or when `edit.key`/`featureId` changes: deselect and remove,
 * so nothing is left in the store to collide with the next session.
 * `addFeatures` swallows a validation rejection silently and
 * `selectFeature` then throws "No feature with this id"; the rejection
 * reason is read off the result and surfaced as `loadError` instead.
 */
export function useGeometryEdit(
  draw: TerraDraw | null,
  edit: GeometryEditRequest | null,
): GeometryEditState {
  const [currentGeometry, setCurrentGeometry] = useState<GeoJSON.Geometry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const originalRef = useRef<GeoJSON.Geometry | null>(null);

  const key = edit?.key ?? null;
  const featureId = edit?.featureId ?? null;

  useEffect(() => {
    if (!draw || !edit) {
      setCurrentGeometry(null);
      setLoadError(null);
      originalRef.current = null;
      return;
    }
    startDraw(draw);
    setDrawMode(draw, 'select');

    const tdId = edit.featureId;
    const geometry = roundCoordsToPrecision(edit.geometry);
    originalRef.current = geometry;
    setCurrentGeometry(geometry);
    setLoadError(null);

    // A previous session on the same id that lost its cleanup race
    // would make the store's duplicate check reject the new one.
    try {
      if (draw.hasFeature(tdId)) draw.removeFeatures([tdId]);
    } catch {
      /* ignore */
    }

    try {
      const results = draw.addFeatures([
        {
          id: tdId,
          type: 'Feature',
          geometry: geometry as never,
          properties: { mode: drawModeFor(edit.geometryType) },
        },
      ]);
      const rejection = (results ?? []).find((r) => !r.valid);
      if (rejection) {
        setLoadError(
          `Could not load geometry: ${rejection.reason ?? 'unknown reason'}`,
        );
      } else {
        draw.selectFeature(tdId);
      }
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? `Could not load geometry: ${err.message}`
          : 'Could not load geometry into the editor.',
      );
    }

    const handleChange = (ids: Array<string | number>) => {
      if (!ids.includes(tdId)) return;
      const f = draw.getSnapshot().find((x) => String(x.id) === tdId);
      if (f) setCurrentGeometry(f.geometry as GeoJSON.Geometry);
    };
    draw.on('change', handleChange);

    return () => {
      try {
        draw.off('change', handleChange);
      } catch {
        /* race on unmount */
      }
      try {
        draw.deselectFeature(tdId);
      } catch {
        /* race on unmount */
      }
      try {
        draw.removeFeatures([tdId]);
      } catch {
        /* race on unmount */
      }
    };
    // Keyed on identity, not on the geometry object: the caller's
    // state may rebuild the request on every render, and re-running
    // this on each one would reload the feature mid-drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw, key, featureId]);

  // Memoised on the two geometry identities: the original only changes
  // when a session starts and the current one only on a drag, but the
  // owning component re-renders far more often than that (toolbar
  // hover, toasts), and two full serialisations of a large polygon per
  // render is noticeable. originalRef is written in the same effect
  // that sets currentGeometry, so it is settled whenever the memo runs
  // with a non-null current geometry.
  const original = originalRef.current;
  const dirty = useMemo(
    () =>
      currentGeometry !== null &&
      original !== null &&
      JSON.stringify(currentGeometry) !== JSON.stringify(original),
    [currentGeometry, original],
  );

  return { currentGeometry, dirty, loadError };
}

/**
 * Cursor override for precise placement. MapLibre styles
 * `.maplibregl-canvas-container.maplibregl-interactive` with
 * `cursor: grab` directly, so the child canvas inherits it whatever
 * its own style says; setting inline on the container wins.
 */
export function useCrosshairCursor(map: maplibregl.Map | null, active: boolean): void {
  useEffect(() => {
    if (!map) return;
    const container = map.getCanvasContainer();
    if (!container) return;
    container.style.cursor = active ? 'crosshair' : '';
    return () => {
      container.style.cursor = '';
    };
  }, [map, active]);
}
