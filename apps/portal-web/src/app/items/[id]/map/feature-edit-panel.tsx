// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * The map builder's Edit feature panel, modelled on the ArcGIS Online
 * Editor widget: one surface for a feature's attributes, its shape and
 * the records related to it.
 *
 *  - Attributes are the editor item's AttributeForm. Update writes the
 *    changed fields and, when the shape was dragged, the new geometry,
 *    in one PATCH (the parent hook owns that call).
 *  - The shape is live on the map as soon as the panel opens; this
 *    panel only reports whether it changed.
 *  - Related records are the rows of each related table (sublayers of
 *    the same item whose parent is this layer). A row opens its own
 *    form in place of the feature's, the way the Editor widget drills
 *    into a related record; Back returns with the feature's unsaved
 *    edits intact, because its form stays mounted (hidden) meanwhile.
 *    Related rows save on their own, immediately.
 */

import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Loader2, Plus, Trash2 } from 'lucide-react';
import type { DataLayerSublayer, FeatureField, PickListData } from '@gratis-gis/shared-types';
import { toast } from '@/lib/toast';
import { parseApiError } from '@/lib/api-error';
import { useT } from '@/lib/i18n/locale-context';
import { useConfirm } from '@/components/dialog-provider';
import { changedValues } from '@/lib/feature-attribute-diff';
import { AttributeForm } from '../editor/attribute-form';
import { useChildTables } from './related-tables';

/** Most related rows listed per table; the panel is not a table view. */
const RELATED_ROW_LIMIT = 50;

export interface FeatureEditPanelProps {
  layerTitle: string;
  itemId: string;
  layerKey: string;
  featureId: string;
  fields: FeatureField[];
  pickLists: Record<string, PickListData>;
  /** The row as the server returned it when the panel opened. */
  initial: Record<string, unknown>;
  /** The layer has a geometry the person can drag on the map. */
  hasShape: boolean;
  shapeDirty: boolean;
  shapeError: string | null;
  busy: boolean;
  error: string | null;
  onSave: (values: Record<string, unknown>) => void;
  onDelete: () => void;
  onClose: () => void;
}

type View =
  | { kind: 'feature' }
  | { kind: 'related-edit'; table: DataLayerSublayer; row: Record<string, unknown> }
  | { kind: 'related-add'; table: DataLayerSublayer };

export function FeatureEditPanel(props: FeatureEditPanelProps) {
  const t = useT();
  const confirm = useConfirm();
  const [view, setView] = useState<View>({ kind: 'feature' });
  const [relatedBusy, setRelatedBusy] = useState(false);
  const [relatedError, setRelatedError] = useState<string | null>(null);
  // Bumped after a related write so the lists re-read.
  const [relatedVersion, setRelatedVersion] = useState(0);

  const back = useCallback(() => {
    setView({ kind: 'feature' });
    setRelatedError(null);
  }, []);

  const rowUrl = (table: DataLayerSublayer, rowId?: string) =>
    `/api/portal/items/${props.itemId}/layers/${encodeURIComponent(table.id)}/features${
      rowId ? `/${encodeURIComponent(rowId)}` : ''
    }`;

  const saveRelated = async (values: Record<string, unknown>) => {
    if (view.kind === 'feature') return;
    const table = view.table;
    const fk = table.parentFkColumn!;
    setRelatedBusy(true);
    setRelatedError(null);
    try {
      let res: Response;
      if (view.kind === 'related-add') {
        res = await fetch(rowUrl(table), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            features: [
              {
                globalId: crypto.randomUUID(),
                geometry: null,
                // The link to this feature is set here, not typed.
                properties: { ...values, [fk]: props.featureId },
              },
            ],
          }),
        });
      } else {
        const rowId = view.row._global_id;
        if (typeof rowId !== 'string') return;
        const changed = changedValues(view.row, values);
        if (Object.keys(changed).length === 0) {
          back();
          return;
        }
        res = await fetch(rowUrl(table, rowId), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ properties: changed }),
        });
      }
      if (!res.ok) {
        setRelatedError(await parseApiError(res, t('featureEdit.saveFailed')));
        return;
      }
      toast.success(
        view.kind === 'related-add'
          ? t('featureEdit.relatedAdded')
          : t('featureEdit.relatedSaved'),
      );
      setRelatedVersion((v) => v + 1);
      back();
    } catch (err) {
      setRelatedError(err instanceof Error ? err.message : t('featureEdit.saveFailed'));
    } finally {
      setRelatedBusy(false);
    }
  };

  const deleteRelated = async () => {
    if (view.kind !== 'related-edit') return;
    const rowId = view.row._global_id;
    if (typeof rowId !== 'string') return;
    const ok = await confirm({
      title: t('featureEdit.relatedDeleteTitle'),
      message: t('featureEdit.relatedDeleteMessage', { table: view.table.label }),
      confirmLabel: t('featureEdit.deleteAction'),
      variant: 'danger',
    });
    if (!ok) return;
    setRelatedBusy(true);
    try {
      const res = await fetch(rowUrl(view.table, rowId), { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        setRelatedError(await parseApiError(res, t('featureEdit.deleteFailed')));
        return;
      }
      toast.success(t('featureEdit.relatedDeleted'));
      setRelatedVersion((v) => v + 1);
      back();
    } finally {
      setRelatedBusy(false);
    }
  };

  const childFields = (table: DataLayerSublayer) =>
    table.fields.filter((f) => f.name !== table.parentFkColumn);

  return (
    <aside
      aria-label={t('featureEdit.editFeatureTitle')}
      className="absolute bottom-3 right-3 top-3 z-20 flex w-[340px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-raised"
    >
      {/* The feature's form stays mounted under a related record so
          its unsaved edits survive the round trip. */}
      <div className={view.kind === 'feature' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        <AttributeForm
          fields={props.fields}
          editableFieldNames={null}
          pickLists={props.pickLists}
          initial={props.initial}
          layerTitle={props.layerTitle}
          submitting={props.busy}
          errorMessage={props.error}
          onCancel={props.onClose}
          onSubmit={props.onSave}
          submitLabel={t('featureEdit.updateAction')}
          title={t('featureEdit.editFeatureTitle')}
          extraFooter={
            <button
              type="button"
              onClick={props.onDelete}
              disabled={props.busy}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-danger hover:bg-danger/10 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('featureEdit.popupDelete')}
            </button>
          }
          extraBody={
            <>
              {props.hasShape ? (
                <ShapeStatus dirty={props.shapeDirty} error={props.shapeError} />
              ) : null}
              <RelatedRecords
                itemId={props.itemId}
                layerKey={props.layerKey}
                parentId={props.featureId}
                version={relatedVersion}
                onOpen={(table, row) => setView({ kind: 'related-edit', table, row })}
                onAdd={(table) => setView({ kind: 'related-add', table })}
              />
            </>
          }
        />
      </div>

      {view.kind !== 'feature' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <AttributeForm
            key={
              view.kind === 'related-edit'
                ? `edit:${String(view.row._global_id)}`
                : `add:${view.table.id}`
            }
            fields={childFields(view.table)}
            editableFieldNames={null}
            pickLists={props.pickLists}
            initial={view.kind === 'related-edit' ? view.row : {}}
            layerTitle={t('featureEdit.relatedOf', {
              table: view.table.label,
              layer: props.layerTitle,
            })}
            submitting={relatedBusy}
            errorMessage={relatedError}
            onCancel={back}
            onSubmit={(values) => void saveRelated(values)}
            submitLabel={
              view.kind === 'related-add'
                ? t('featureEdit.relatedAdd')
                : t('featureEdit.updateAction')
            }
            title={
              view.kind === 'related-add'
                ? t('featureEdit.relatedAddTitle', { table: view.table.label })
                : t('featureEdit.relatedEditTitle', { table: view.table.label })
            }
            extraFooter={
              view.kind === 'related-edit' ? (
                <button
                  type="button"
                  onClick={() => void deleteRelated()}
                  disabled={relatedBusy}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-danger hover:bg-danger/10 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('featureEdit.popupDelete')}
                </button>
              ) : null
            }
          />
        </div>
      ) : null}
    </aside>
  );
}

function ShapeStatus({ dirty, error }: { dirty: boolean; error: string | null }) {
  const t = useT();
  return (
    <section className="rounded-md border border-border bg-surface-2 px-3 py-2">
      <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted">
        {t('featureEdit.shapeHeading')}
      </h3>
      {error ? (
        <p className="mt-1 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : (
        <p className="mt-1 text-xs text-ink-1">
          {dirty ? t('featureEdit.shapeChanged') : t('featureEdit.shapeHint')}
        </p>
      )}
    </section>
  );
}

function RelatedRecords({
  itemId,
  layerKey,
  parentId,
  version,
  onOpen,
  onAdd,
}: {
  itemId: string;
  layerKey: string;
  parentId: string;
  version: number;
  onOpen: (table: DataLayerSublayer, row: Record<string, unknown>) => void;
  onAdd: (table: DataLayerSublayer) => void;
}) {
  const { children, failed } = useChildTables(itemId, layerKey);
  if (failed || !children || children.length === 0) return null;
  return (
    <>
      {children.map((table) => (
        <RelatedTable
          key={table.id}
          itemId={itemId}
          table={table}
          parentId={parentId}
          version={version}
          onOpen={(row) => onOpen(table, row)}
          onAdd={() => onAdd(table)}
        />
      ))}
    </>
  );
}

function RelatedTable({
  itemId,
  table,
  parentId,
  version,
  onOpen,
  onAdd,
}: {
  itemId: string;
  table: DataLayerSublayer;
  parentId: string;
  version: number;
  onOpen: (row: Record<string, unknown>) => void;
  onAdd: () => void;
}) {
  const t = useT();
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const fk = table.parentFkColumn!;

  useEffect(() => {
    const ctrl = new AbortController();
    setFailed(false);
    const qs = new URLSearchParams({
      parentFk: fk,
      parentId,
      limit: String(RELATED_ROW_LIMIT),
    });
    fetch(
      `/api/portal/items/${itemId}/layers/${encodeURIComponent(table.id)}/features?${qs}`,
      { cache: 'no-store', signal: ctrl.signal },
    )
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then(
        (fc: {
          features?: Array<{ properties?: Record<string, unknown> }>;
          nextCursor?: string | null;
        }) => {
          setRows((fc.features ?? []).map((f) => f.properties ?? {}));
          setMore(Boolean(fc.nextCursor));
        },
      )
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') setFailed(true);
      });
    return () => ctrl.abort();
  }, [itemId, table.id, fk, parentId, version]);

  // Adding needs no geometry only on an attribute table; a spatial
  // related layer is added by drawing, which this panel does not do.
  const canAdd = table.geometryType === null;

  return (
    <section className="rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <h3 className="text-xs font-semibold text-ink-0">
          {table.label}
          {rows ? (
            <span className="ml-1 font-normal text-muted">
              ({rows.length}
              {more ? '+' : ''})
            </span>
          ) : null}
        </h3>
        {canAdd ? (
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium text-accent hover:bg-surface-2"
          >
            <Plus className="h-3 w-3" />
            {t('featureEdit.relatedAdd')}
          </button>
        ) : null}
      </div>
      {failed ? (
        <p className="px-3 py-2 text-xs text-danger">{t('mapPopupRelated.failed')}</p>
      ) : rows === null ? (
        <p className="flex items-center gap-1 px-3 py-2 text-xs text-muted">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('mapPopupRelated.loading')}
        </p>
      ) : rows.length === 0 ? (
        <p className="px-3 py-2 text-xs italic text-muted">{t('mapPopupRelated.none')}</p>
      ) : (
        <ul className="max-h-56 divide-y divide-border overflow-y-auto">
          {rows.map((row, i) => (
            <li key={typeof row._global_id === 'string' ? row._global_id : i}>
              <button
                type="button"
                onClick={() => onOpen(row)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-ink-1 hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1 truncate">{rowSummary(row, table)}</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** First three filled values of a related row, in declared field order. */
function rowSummary(row: Record<string, unknown>, table: DataLayerSublayer): string {
  const parts: string[] = [];
  for (const f of table.fields) {
    if (f.name === table.parentFkColumn) continue;
    const v = row[f.name];
    if (v === null || v === undefined || v === '') continue;
    parts.push(String(v));
    if (parts.length === 3) break;
  }
  return parts.join(' · ') || '—';
}
