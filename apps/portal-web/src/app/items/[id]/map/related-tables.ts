// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import type { DataLayerSublayer } from '@gratis-gis/shared-types';

/**
 * The related tables of one sublayer: the other sublayers of the same
 * v3 data_layer item whose `parentLayerId` points at it and that name
 * the column holding the parent's `_global_id`. Shared by the popup
 * editor (which tables a popup may list) and the feature edit panel
 * (which tables a person may edit under a feature).
 *
 * `children` is null while loading; `failed` is true when the item
 * could not be read.
 */
export function useChildTables(
  itemId: string | null,
  layerKey: string | null,
): { children: DataLayerSublayer[] | null; failed: boolean } {
  const [children, setChildren] = useState<DataLayerSublayer[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setChildren(null);
    setFailed(false);
    if (!itemId || !layerKey) {
      setChildren([]);
      return;
    }
    const ctrl = new AbortController();
    fetch(`/api/portal/items/${itemId}`, { signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((item: { data?: { layers?: DataLayerSublayer[] } }) => {
        const layers = item.data?.layers ?? [];
        setChildren(
          layers.filter((l) => l.parentLayerId === layerKey && Boolean(l.parentFkColumn)),
        );
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') setFailed(true);
      });
    return () => ctrl.abort();
  }, [itemId, layerKey]);

  return { children, failed };
}
