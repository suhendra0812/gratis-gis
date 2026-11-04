// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import {
  relatedTableRefs,
  type DataLayerSublayer,
} from '@gratis-gis/shared-types';

/**
 * One related table of a sublayer, resolved to the sublayer it points
 * at (which may be in another data_layer item).
 */
export interface RelatedTable {
  /** data_layer item holding the related table. */
  itemId: string;
  /** The related table's own sublayer (fields, geometry type). */
  layer: DataLayerSublayer;
  /** Column on the related table holding the parent's `_global_id`. */
  fkColumn: string;
  label: string;
}

type ItemData = { data?: { version?: number; layers?: DataLayerSublayer[] } };

/**
 * Resolve every related table of `layerKey` in `itemId`: in-item
 * children and relationships the parent declares (see
 * `relatedTableRefs`), each looked up in its own item.
 *
 * A reference is dropped when its table is gone or, for another
 * item, when the link column is not a declared field there: the
 * feature API ignores a filter on an undeclared column and would list
 * every row. An item the viewer cannot read drops its tables too;
 * reading them would fail anyway.
 */
export async function resolveRelatedTables(
  itemId: string,
  layerKey: string,
  signal?: AbortSignal,
): Promise<RelatedTable[]> {
  const load = async (id: string): Promise<DataLayerSublayer[] | null> => {
    const res = await fetch(`/api/portal/items/${id}`, signal ? { signal } : {});
    if (!res.ok) return null;
    const item = (await res.json()) as ItemData;
    return item.data?.version === 3 ? (item.data.layers ?? []) : null;
  };

  const own = await load(itemId);
  if (!own) throw new Error('Could not read the data layer.');
  const refs = relatedTableRefs(itemId, own, layerKey);

  const byItem = new Map<string, DataLayerSublayer[] | null>([[itemId, own]]);
  for (const ref of refs) {
    if (byItem.has(ref.itemId)) continue;
    byItem.set(ref.itemId, await load(ref.itemId).catch(() => null));
  }

  const out: RelatedTable[] = [];
  for (const ref of refs) {
    const layer = byItem.get(ref.itemId)?.find((l) => l.id === ref.layerId);
    if (!layer) continue;
    const declared = layer.fields.some((f) => f.name === ref.fkColumn);
    // An in-item child's parentFkColumn is honoured by the API even
    // when it is not listed among the fields.
    const inItemFk = ref.itemId === itemId && layer.parentFkColumn === ref.fkColumn;
    if (!declared && !inItemFk) continue;
    out.push({ itemId: ref.itemId, layer, fkColumn: ref.fkColumn, label: ref.label });
  }
  return out;
}

/**
 * React wrapper around resolveRelatedTables. `tables` is null while
 * loading; `failed` is true when the parent item could not be read.
 * Shared by the popup editor and the feature edit panel.
 */
export function useRelatedTables(
  itemId: string | null,
  layerKey: string | null,
): { tables: RelatedTable[] | null; failed: boolean } {
  const [tables, setTables] = useState<RelatedTable[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setTables(null);
    setFailed(false);
    if (!itemId || !layerKey) {
      setTables([]);
      return;
    }
    const ctrl = new AbortController();
    resolveRelatedTables(itemId, layerKey, ctrl.signal)
      .then(setTables)
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') setFailed(true);
      });
    return () => ctrl.abort();
  }, [itemId, layerKey]);

  return { tables, failed };
}

/** Key a related table across items. */
export function relatedTableKey(t: { itemId: string; layer: { id: string } }): string {
  return `${t.itemId}:${t.layer.id}`;
}
