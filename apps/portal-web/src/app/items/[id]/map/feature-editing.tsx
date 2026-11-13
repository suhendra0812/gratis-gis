// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Feature editing inside the map builder: edit a feature (attributes,
 * shape and related records in one panel, see feature-edit-panel.tsx),
 * add a feature, delete a feature, on any data layer the viewer may
 * write to. The steward's tools, not the editor item's:
 * no templates, no per-field allowlists, no snapping profiles, no
 * undo stack. Someone who needs those builds an editor item, which is
 * what it is for.
 *
 * Why this exists at all: a person who created a layer could not fix
 * one wrong vertex without first standing up a dedicated editing app
 * on top of it. The attribute stage covered attributes through the attribute table;
 * this covers the shape.
 *
 * Shape of the integration:
 *
 *  - `useFeatureEditing` owns the tool state and every server call,
 *    and hands back three things: props the canvas needs (which
 *    layers' clicks to route here, and whether to suppress popups),
 *    the overlays to render inside the canvas container, and whether
 *    a tool is active so the select toolbar can stand down. The two
 *    tools cannot coexist: both want the click.
 *
 *  - terra-draw comes from the shared hooks in use-terra-draw.ts, the
 *    same instance shape the editor runtime uses.
 *
 *  - Geometry for an edit is fetched from the server, never taken off
 *    the rendered tile. The builder draws data layers as MVT, and a
 *    polygon that crosses a tile edge comes back from
 *    queryRenderedFeatures clipped to that edge; saving it would
 *    truncate the feature. `fetchFeatureFromServer` (fetch-feature.ts,
 *    shared with the editor runtime) returns the whole thing.
 *
 *  - Permission is the layer's, resolved server-side once per page
 *    load (`editableLayerIds`), and re-checked by the server on every
 *    write. The tools here are a convenience gate only.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type * as maplibregl from 'maplibre-gl';
import {
  Loader2,
  Magnet,
  Plus,
  SquarePen,
  Trash2,
} from 'lucide-react';
import type { FeatureField, MapLayer, PickListData } from '@gratis-gis/shared-types';
import { changedValues } from '@/lib/feature-attribute-diff';
import { toast } from '@/lib/toast';
import { parseApiError } from '@/lib/api-error';
import { clientUuid } from '@/lib/uuid';
import { useT } from '@/lib/i18n/locale-context';
import { useConfirm } from '@/components/dialog-provider';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AttributeForm } from '../editor/attribute-form';
import {
  drawModeFor,
  roundCoordsToPrecision,
  setDrawMode,
  startDraw,
  useCrosshairCursor,
  useGeometryEdit,
  useTerraDraw,
  type DrawGeometryType,
  type GeometryEditRequest,
} from './use-terra-draw';
import { fetchFeatureFromServer } from './fetch-feature';
import { FeatureEditPanel } from './feature-edit-panel';
import type { MapCanvasHandle, PopupActions } from './map-canvas';

export type FeatureEditTool = 'off' | 'edit' | 'add' | 'delete';

/** What the builder already knows per editable map layer (attribute stage). */
export interface EditableLayerInfo {
  fields: FeatureField[];
  geometryType: DrawGeometryType | null;
}

interface Args {
  map: maplibregl.Map | null;
  layers: MapLayer[];
  /** Map-layer ids whose underlying data_layer the viewer may write to. */
  editableLayerIds: ReadonlySet<string>;
  /** Declared schema and geometry per editable map layer, keyed by map-layer id. */
  layerInfo: Record<string, EditableLayerInfo>;
  pickLists: Record<string, PickListData>;
  canvasRef: React.RefObject<MapCanvasHandle | null>;
}

interface CanvasProps {
  editClaimedLayerIds: ReadonlySet<string>;
  onEditClaimedClick: (info: {
    layerId: string;
    featureId: string | number;
    properties: Record<string, unknown>;
  }) => void;
  suppressPopup: boolean;
}

export interface FeatureEditing {
  tool: FeatureEditTool;
  /** True while any tool is active; the select toolbar should be off. */
  active: boolean;
  /** Leave whatever tool is active, discarding an unsaved sketch or edit. */
  deactivate: () => void;
  canvasProps: CanvasProps;
  /**
   * Edit / Edit shape / Delete for the click popup. Undefined when
   * the viewer can edit no layer on this map, so the popup stays
   * read-only (Zoom to only).
   */
  popupActions: PopupActions | undefined;
  overlay: ReactNode;
}

interface PendingGeometryEdit extends GeometryEditRequest {
  properties: Record<string, unknown>;
  layerTitle: string;
}

interface PendingCreate {
  layerId: string;
  geometry: GeoJSON.Geometry;
  /** terra-draw's id for the sketch, so it can be removed after submit or cancel. */
  sketchId: string | number;
  layerTitle: string;
}

function dataLayerSource(layer: MapLayer | undefined) {
  if (!layer || layer.source.kind !== 'data-layer') return null;
  const { itemId, layerKey } = layer.source;
  if (typeof layerKey !== 'string' || !layerKey) return null;
  return { itemId, layerKey };
}

export function useFeatureEditing({
  map,
  layers,
  editableLayerIds,
  layerInfo,
  pickLists,
  canvasRef,
}: Args): FeatureEditing {
  const t = useT();
  const confirm = useConfirm();
  const [tool, setTool] = useState<FeatureEditTool>('off');
  const [snapping, setSnapping] = useState(false);
  // The layer an Add draws into. Defaults to the first editable layer
  // that has a geometry; a table layer has nothing to draw.
  const [addLayerId, setAddLayerId] = useState<string | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingGeometryEdit | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadingFeature, setLoadingFeature] = useState(false);
  // The feature open in the Edit feature panel, if any.
  const [featureEdit, setFeatureEdit] = useState<ActiveFeatureEdit | null>(null);

  // terra-draw is only mounted once there is something to edit. The
  // hook's dynamic import is the whole reason the read-only path stays
  // light, and mounting it unconditionally made every viewer of every
  // map download it. Handing the hook null until then is the same as
  // the map not having loaded yet, which it already handles.
  const { draw, ready } = useTerraDraw(editableLayerIds.size > 0 ? map : null, {
    snapping,
    // Snap onto the features of every layer on the map, not only the
    // sketch, and mark the vertices that snapped.
    snapToMap: true,
  });
  const geometryEdit = useGeometryEdit(draw, pendingEdit);

  const drawableLayers = useMemo(
    () =>
      layers.filter(
        (l) => editableLayerIds.has(l.id) && layerInfo[l.id]?.geometryType,
      ),
    [layers, editableLayerIds, layerInfo],
  );

  // Keep the add target valid as layers come and go.
  useEffect(() => {
    if (addLayerId && drawableLayers.some((l) => l.id === addLayerId)) return;
    setAddLayerId(drawableLayers[0]?.id ?? null);
  }, [drawableLayers, addLayerId]);

  const active = tool !== 'off';
  useCrosshairCursor(map, active);

  // terra-draw mode follows the tool. It is only STARTED for a draw or
  // an edit session; an inert instance does not compete with the
  // canvas for clicks in edit/delete mode, where the canvas's own
  // click routing is what identifies the feature.
  useEffect(() => {
    if (!draw || !ready) return;
    if (tool === 'add' && addLayerId && !pendingCreate) {
      const gt = layerInfo[addLayerId]?.geometryType;
      if (!gt) return;
      startDraw(draw);
      setDrawMode(draw, drawModeFor(gt));
      return;
    }
    if (pendingEdit) return; // useGeometryEdit owns the mode
    setDrawMode(draw, 'select');
  }, [draw, ready, tool, addLayerId, pendingCreate, pendingEdit, layerInfo]);

  // A finished sketch becomes a pending create; the attribute form
  // collects what the layer requires. The sketch stays in the store,
  // painted, until the form resolves, so the person can see what they
  // are describing.
  useEffect(() => {
    if (!draw || !ready || tool !== 'add') return;
    const handleFinish = (id: string | number) => {
      if (!addLayerId) return;
      const f = draw.getSnapshot().find((x) => String(x.id) === String(id));
      if (!f || !f.geometry) return;
      const layer = layers.find((l) => l.id === addLayerId);
      setPendingCreate({
        layerId: addLayerId,
        geometry: f.geometry as GeoJSON.Geometry,
        sketchId: id,
        layerTitle: layer?.title ?? t('featureEdit.unnamedLayer'),
      });
      setDrawMode(draw, 'select');
    };
    draw.on('finish', handleFinish);
    return () => {
      try {
        draw.off('finish', handleFinish);
      } catch {
        /* race on unmount */
      }
    };
  }, [draw, ready, tool, addLayerId, layers, t]);

  const clearSketch = useCallback(
    (sketchId: string | number) => {
      if (!draw) return;
      try {
        if (draw.hasFeature(sketchId)) draw.removeFeatures([sketchId]);
      } catch {
        /* already gone */
      }
    },
    [draw],
  );

  // Moves on whenever the tool is left or switched, so a feature load
  // that finishes afterwards is dropped instead of opening an edit
  // session for a tool that is no longer active.
  const toolEpochRef = useRef(0);

  const leaveTool = useCallback(() => {
    toolEpochRef.current += 1;
    if (pendingCreate) clearSketch(pendingCreate.sketchId);
    setPendingCreate(null);
    setPendingEdit(null);
    setFeatureEdit(null);
    setSaveError(null);
    setTool('off');
    if (draw) {
      try {
        draw.stop();
      } catch {
        /* never started */
      }
    }
  }, [draw, pendingCreate, clearSketch]);

  const selectTool = useCallback(
    (next: FeatureEditTool) => {
      if (next === tool || next === 'off') {
        leaveTool();
        return;
      }
      toolEpochRef.current += 1;
      if (pendingCreate) clearSketch(pendingCreate.sketchId);
      setPendingCreate(null);
      setPendingEdit(null);
      setFeatureEdit(null);
      setSaveError(null);
      setTool(next);
    },
    [tool, leaveTool, pendingCreate, clearSketch],
  );

  // Delete one feature after a confirm. Shared by the Delete tool, the
  // popup's Delete button and the edit panel. Resolves true if deleted.
  const deleteFeature = useCallback(
    async (layer: MapLayer, featureId: string): Promise<boolean> => {
      const src = dataLayerSource(layer);
      if (!src) return false;
      const ok = await confirm({
        title: t('featureEdit.deleteConfirmTitle'),
        message: t('featureEdit.deleteConfirmMessage', { layer: layer.title }),
        confirmLabel: t('featureEdit.deleteAction'),
        variant: 'danger',
      });
      if (!ok) return false;
      setBusy(true);
      try {
        const res = await fetch(
          `/api/portal/items/${src.itemId}/layers/${encodeURIComponent(src.layerKey)}/features/${encodeURIComponent(featureId)}`,
          { method: 'DELETE' },
        );
        if (!res.ok && res.status !== 204) {
          throw new Error(await parseApiError(res, t('featureEdit.deleteFailed')));
        }
        canvasRef.current?.refreshLayerSource(layer.id);
        toast.success(t('featureEdit.featureDeleted'));
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('featureEdit.deleteFailed'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [confirm, canvasRef, t],
  );

  // ---- Edit feature panel ------------------------------------------
  //
  // One panel for a feature's attributes, shape and related records,
  // like the ArcGIS Online Editor widget. It opens from the Edit tool
  // (click a feature) or from a popup's Edit button. The shape is live
  // on the map from the start (a geometry session on the same
  // feature), and Update writes attributes and shape together.

  const closeFeatureEdit = useCallback(() => {
    const fromPopup = featureEdit?.fromPopup ?? false;
    setFeatureEdit(null);
    setPendingEdit(null);
    setSaveError(null);
    // Opened from a popup: the Edit tool was armed for this one
    // feature, so hand the map back to plain browsing.
    if (fromPopup) {
      setTool('off');
      if (draw) {
        try {
          draw.stop();
        } catch {
          /* never started */
        }
      }
    }
  }, [featureEdit, draw]);

  const openFeatureEdit = useCallback(
    async (layer: MapLayer, featureId: string, fromPopup: boolean) => {
      const src = dataLayerSource(layer);
      if (!src) return;
      if (fromPopup) {
        // The Edit tool is what suppresses popups and keeps clicks on
        // the shape's handles while the panel is open.
        if (pendingCreate) clearSketch(pendingCreate.sketchId);
        setPendingCreate(null);
        setTool('edit');
      }
      setLoadingFeature(true);
      setSaveError(null);
      // A tool switch or Escape while the read is in flight bumps the
      // epoch; a late answer must not open a panel nobody asked for.
      const epoch = toolEpochRef.current;
      try {
        const full = await fetchFeatureFromServer(
          src.itemId,
          src.layerKey,
          featureId,
          t('featureEdit.loadFailed'),
        );
        if (epoch !== toolEpochRef.current) return;
        if (!full) {
          toast.error(t('featureEdit.notFound'));
          if (fromPopup) setTool('off');
          return;
        }
        const gt = layerInfo[layer.id]?.geometryType ?? null;
        setFeatureEdit({
          layerId: layer.id,
          featureId,
          layerTitle: layer.title,
          itemId: src.itemId,
          layerKey: src.layerKey,
          initial: full.properties,
          hasShape: gt !== null && Boolean(full.geometry),
          fromPopup,
        });
        if (map && full.geometry) keepClearOfPanel(map, full.geometry);
        setPendingEdit(
          gt && full.geometry
            ? {
                key: layer.id,
                featureId,
                geometryType: gt,
                geometry: roundCoordsToPrecision(full.geometry),
                properties: full.properties,
                layerTitle: layer.title,
              }
            : null,
        );
      } catch (err) {
        if (epoch !== toolEpochRef.current) return;
        toast.error(err instanceof Error ? err.message : t('featureEdit.loadFailed'));
        if (fromPopup) setTool('off');
      } finally {
        setLoadingFeature(false);
      }
    },
    [map, layerInfo, pendingCreate, clearSketch, t],
  );

  const saveFeature = useCallback(
    async (values: Record<string, unknown>) => {
      if (!featureEdit) return;
      const layer = layers.find((l) => l.id === featureEdit.layerId);
      const src = dataLayerSource(layer);
      if (!layer || !src) return;
      // Only what changed (see changedValues), plus the shape if it
      // was dragged: one write, one undo step on the server side.
      const changed = changedValues(featureEdit.initial, values);
      const body: { properties?: Record<string, unknown>; geometry?: GeoJSON.Geometry } = {};
      if (Object.keys(changed).length > 0) body.properties = changed;
      if (geometryEdit.dirty && geometryEdit.currentGeometry) {
        body.geometry = geometryEdit.currentGeometry;
      }
      if (!body.properties && !body.geometry) {
        closeFeatureEdit();
        return;
      }
      setBusy(true);
      setSaveError(null);
      try {
        const res = await fetch(
          `/api/portal/items/${src.itemId}/layers/${encodeURIComponent(src.layerKey)}/features/${encodeURIComponent(featureEdit.featureId)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) {
          setSaveError(await parseApiError(res, t('featureEdit.saveFailed')));
          return;
        }
        canvasRef.current?.refreshLayerSource(layer.id);
        toast.success(t('featureEdit.featureUpdated'));
        closeFeatureEdit();
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : t('featureEdit.saveFailed'));
      } finally {
        setBusy(false);
      }
    },
    [featureEdit, layers, geometryEdit.dirty, geometryEdit.currentGeometry, canvasRef, closeFeatureEdit, t],
  );

  const deleteFromPanel = useCallback(async () => {
    if (!featureEdit) return;
    const layer = layers.find((l) => l.id === featureEdit.layerId);
    if (!layer) return;
    if (await deleteFeature(layer, featureEdit.featureId)) closeFeatureEdit();
  }, [featureEdit, layers, deleteFeature, closeFeatureEdit]);

  const onEditClaimedClick = useCallback(
    (info: { layerId: string; featureId: string | number; properties: Record<string, unknown> }) => {
      if (tool !== 'edit' && tool !== 'delete') return;
      const layer = layers.find((l) => l.id === info.layerId);
      if (!layer || !dataLayerSource(layer)) return;
      // The tile carries _global_id; MapCanvas's generateId rewrite
      // means info.featureId may be a sequential number instead.
      const featureId =
        typeof info.properties._global_id === 'string'
          ? info.properties._global_id
          : typeof info.featureId === 'string'
            ? info.featureId
            : null;
      if (!featureId) {
        toast.error(t('featureEdit.noStableId'));
        return;
      }

      if (tool === 'delete') {
        void deleteFeature(layer, featureId);
        return;
      }

      // A click while the panel is open is a handle drag or a
      // mis-click, not a request to switch features. Switching would
      // discard the unsaved edit without a word; Cancel is explicit.
      if (featureEdit || loadingFeature) return;
      void openFeatureEdit(layer, featureId, false);
    },
    [tool, layers, featureEdit, loadingFeature, deleteFeature, openFeatureEdit, t],
  );

  const popupActions: PopupActions | undefined = useMemo(() => {
    if (editableLayerIds.size === 0) return undefined;
    const layerOf = (id: string) => layers.find((l) => l.id === id);
    return {
      canEdit: (layerId) =>
        editableLayerIds.has(layerId) && dataLayerSource(layerOf(layerId)) !== null,
      onEdit: (ref) => {
        const layer = layerOf(ref.layerId);
        if (layer) void openFeatureEdit(layer, ref.featureId, true);
      },
      onDelete: (ref) => {
        const layer = layerOf(ref.layerId);
        if (layer) void deleteFeature(layer, ref.featureId);
      },
    };
  }, [editableLayerIds, layers, openFeatureEdit, deleteFeature]);

  const submitCreate = useCallback(
    async (values: Record<string, unknown>) => {
      if (!pendingCreate) return;
      const layer = layers.find((l) => l.id === pendingCreate.layerId);
      const src = dataLayerSource(layer);
      if (!layer || !src) return;
      setBusy(true);
      setSaveError(null);
      try {
        const res = await fetch(
          `/api/portal/items/${src.itemId}/layers/${encodeURIComponent(src.layerKey)}/features`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              features: [
                {
                  globalId: clientUuid(),
                  geometry: roundCoordsToPrecision(pendingCreate.geometry),
                  properties: values,
                },
              ],
            }),
          },
        );
        if (!res.ok) {
          setSaveError(await parseApiError(res, t('featureEdit.addFailed')));
          return;
        }
        clearSketch(pendingCreate.sketchId);
        setPendingCreate(null);
        canvasRef.current?.refreshLayerSource(layer.id);
        toast.success(t('featureEdit.featureAdded'));
        // Back into draw mode for the next one.
        const gt = layerInfo[layer.id]?.geometryType;
        if (draw && gt) setDrawMode(draw, drawModeFor(gt));
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : t('featureEdit.addFailed'));
      } finally {
        setBusy(false);
      }
    },
    [pendingCreate, layers, canvasRef, clearSketch, draw, layerInfo, t],
  );

  const cancelCreate = useCallback(() => {
    if (pendingCreate) clearSketch(pendingCreate.sketchId);
    setPendingCreate(null);
    setSaveError(null);
    const gt = addLayerId ? layerInfo[addLayerId]?.geometryType : null;
    if (draw && gt) setDrawMode(draw, drawModeFor(gt));
  }, [pendingCreate, clearSketch, addLayerId, layerInfo, draw]);

  const canvasProps: CanvasProps = useMemo(
    () => ({
      editClaimedLayerIds: active ? editableLayerIds : EMPTY_SET,
      onEditClaimedClick,
      suppressPopup: active,
    }),
    [active, editableLayerIds, onEditClaimedClick],
  );

  const overlay =
    editableLayerIds.size === 0 ? null : (
      <>
        <EditToolbar
          tool={tool}
          onSelect={selectTool}
          snapping={snapping}
          onToggleSnapping={() => setSnapping((s) => !s)}
          drawableLayers={drawableLayers}
          addLayerId={addLayerId}
          onAddLayerChange={setAddLayerId}
          canAdd={drawableLayers.length > 0}
          busy={busy || loadingFeature}
        />
        {tool === 'edit' && !featureEdit ? (
          <Hint>
            {loadingFeature
              ? t('featureEdit.hintLoading')
              : t('featureEdit.hintEdit')}
          </Hint>
        ) : null}
        {tool === 'delete' ? <Hint>{t('featureEdit.hintDelete')}</Hint> : null}
        {tool === 'add' && !pendingCreate && addLayerId ? (
          <Hint>
            {layerInfo[addLayerId]?.geometryType === 'point'
              ? t('featureEdit.hintAddPoint')
              : t('featureEdit.hintAddPath')}
          </Hint>
        ) : null}
        {featureEdit ? (
          <FeatureEditPanel
            // A different feature is a fresh panel, not a re-seed.
            key={`${featureEdit.layerId}:${featureEdit.featureId}`}
            layerTitle={featureEdit.layerTitle}
            itemId={featureEdit.itemId}
            layerKey={featureEdit.layerKey}
            featureId={featureEdit.featureId}
            fields={layerInfo[featureEdit.layerId]?.fields ?? []}
            pickLists={pickLists}
            initial={featureEdit.initial}
            hasShape={featureEdit.hasShape}
            shapeDirty={geometryEdit.dirty}
            shapeError={geometryEdit.loadError}
            busy={busy}
            error={saveError}
            onSave={(values) => void saveFeature(values)}
            onDelete={() => void deleteFromPanel()}
            onClose={closeFeatureEdit}
          />
        ) : null}
        <Dialog
          open={pendingCreate !== null}
          onOpenChange={(open) => {
            if (!open) cancelCreate();
          }}
        >
          {/* AttributeForm draws its own close affordance; a second X
              from the dialog chrome read as two different actions. */}
          <DialogContent hideCloseButton>
            <DialogHeader>
              <DialogTitle>{t('featureEdit.newFeatureTitle')}</DialogTitle>
            </DialogHeader>
            {pendingCreate ? (
              <AttributeForm
                key={`${pendingCreate.layerId}:${pendingCreate.sketchId}`}
                fields={layerInfo[pendingCreate.layerId]?.fields ?? []}
                editableFieldNames={null}
                pickLists={pickLists}
                layerTitle={pendingCreate.layerTitle}
                submitting={busy}
                errorMessage={saveError}
                onCancel={cancelCreate}
                onSubmit={(values) => void submitCreate(values)}
                submitLabel={t('featureEdit.addAction')}
                title={t('featureEdit.newFeatureAttributes')}
              />
            ) : null}
          </DialogContent>
        </Dialog>
      </>
    );

  return { tool, active, deactivate: leaveTool, canvasProps, popupActions, overlay };
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** Width the edit panel takes from the right of the map, plus its gap. */
const PANEL_CLEARANCE_PX = 356;

/**
 * Pan the map just enough that a feature hidden under the edit panel
 * comes out from behind it, centred in the part of the map still
 * visible. A feature already clear of the panel leaves the camera
 * alone. Only the horizontal pan matters: the panel is full height.
 */
function keepClearOfPanel(map: maplibregl.Map, geometry: GeoJSON.Geometry) {
  const c = geometryCenter(geometry);
  if (!c) return;
  const { width } = map.getContainer().getBoundingClientRect();
  const visible = width - PANEL_CLEARANCE_PX;
  if (visible < 120) return; // too narrow to help; the panel covers the map
  const { x } = map.project(c);
  if (x < visible - 24) return;
  map.panBy([x - visible / 2, 0]);
}

/** Centre of a geometry's bounding box. */
export function geometryCenter(g: GeoJSON.Geometry): [number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      minX = Math.min(minX, c[0]);
      maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1] as number);
      maxY = Math.max(maxY, c[1] as number);
      return;
    }
    for (const part of c) visit(part);
  };
  const walk = (geom: GeoJSON.Geometry): void => {
    if (geom.type === 'GeometryCollection') geom.geometries.forEach(walk);
    else visit(geom.coordinates);
  };
  walk(g);
  return Number.isFinite(minX) ? [(minX + maxX) / 2, (minY + maxY) / 2] : null;
}

interface ActiveFeatureEdit {
  layerId: string;
  featureId: string;
  layerTitle: string;
  itemId: string;
  layerKey: string;
  /** The row as the server returned it when the panel opened. */
  initial: Record<string, unknown>;
  /** A geometry session is running on the map for this feature. */
  hasShape: boolean;
  /** Opened from a popup: closing turns the Edit tool back off. */
  fromPopup: boolean;
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute left-1/2 top-4 z-20 -translate-x-1/2 rounded-md border border-border bg-surface-1/95 px-3 py-1.5 text-xs text-ink-1 shadow-card backdrop-blur-xs">
      {children}
    </div>
  );
}

function EditToolbar({
  tool,
  onSelect,
  snapping,
  onToggleSnapping,
  drawableLayers,
  addLayerId,
  onAddLayerChange,
  canAdd,
  busy,
}: {
  tool: FeatureEditTool;
  onSelect: (t: FeatureEditTool) => void;
  snapping: boolean;
  onToggleSnapping: () => void;
  drawableLayers: MapLayer[];
  addLayerId: string | null;
  onAddLayerChange: (id: string) => void;
  canAdd: boolean;
  busy: boolean;
}) {
  const t = useT();
  return (
    <div className="absolute left-4 top-25 z-10 flex items-center gap-1 rounded-lg border border-border bg-surface-1/95 p-1 shadow-raised backdrop-blur-xs">
      <span className="px-1 text-2xs uppercase tracking-wide text-muted">{t('featureEdit.groupLabel')}</span>
      <ToolButton
        icon={SquarePen}
        label={t('featureEdit.editFeatureTool')}
        active={tool === 'edit'}
        onClick={() => onSelect('edit')}
      />
      <ToolButton
        icon={Plus}
        label={t('featureEdit.addFeature')}
        active={tool === 'add'}
        onClick={() => onSelect('add')}
        disabled={!canAdd}
      />
      <ToolButton
        icon={Trash2}
        label={t('featureEdit.deleteFeature')}
        active={tool === 'delete'}
        onClick={() => onSelect('delete')}
      />
      {tool === 'add' && drawableLayers.length > 1 ? (
        <select
          value={addLayerId ?? ''}
          onChange={(e) => onAddLayerChange(e.target.value)}
          className="ml-1 h-7 max-w-48 rounded border border-border bg-surface-1 px-1 text-2xs text-ink-1 focus:border-accent focus:outline-hidden"
          aria-label={t('featureEdit.layerToAddTo')}
        >
          {drawableLayers.map((l) => (
            <option key={l.id} value={l.id}>
              {l.title}
            </option>
          ))}
        </select>
      ) : null}
      {tool !== 'off' ? (
        <>
          <div className="mx-1 h-5 w-px bg-border" />
          <ToolButton
            icon={Magnet}
            label={snapping ? t('featureEdit.snappingOn') : t('featureEdit.snappingOff')}
            active={snapping}
            onClick={onToggleSnapping}
          />
        </>
      ) : null}
      {busy ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin text-muted" /> : null}
    </div>
  );
}

function ToolButton({
  icon: Icon,
  label,
  active,
  onClick,
  disabled = false,
}: {
  icon: typeof Plus;
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      className={`inline-flex h-7 w-7 items-center justify-center rounded transition-colors disabled:opacity-40 ${
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted hover:bg-surface-2 hover:text-ink-0'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
