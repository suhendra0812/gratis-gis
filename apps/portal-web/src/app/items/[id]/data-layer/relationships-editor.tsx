// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Relationships to related tables, declared on a parent sublayer
 * (`DataLayerSublayer.relationships`). The related table may be in
 * this data layer or in another one: inspections kept in their own
 * item, shared by several asset layers, is the case this exists for.
 *
 * It is the declaration side of the one relationship model the map
 * popup, the map's Edit feature panel and the field app read through
 * `relatedTableRefs`. In-item tables created with the event-layer
 * wizard are related already and are not repeated here.
 *
 * Only declared fields of the related table can be the link column:
 * the feature API ignores a parent filter on an undeclared column and
 * would return every row.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link2, Plus, Trash2, X } from 'lucide-react';
import type {
  DataLayerDataV3,
  DataLayerSublayer,
  Item,
  SublayerRelationship,
} from '@gratis-gis/shared-types';
import { useT } from '@/lib/i18n/locale-context';
import { clientUuid } from '@/lib/uuid';

type LayerOption = { id: string; label: string };

export function RelationshipsEditor({
  itemId,
  data,
  onChange,
  canEdit,
}: {
  itemId: string;
  data: DataLayerDataV3;
  onChange: (next: DataLayerDataV3) => void;
  canEdit: boolean;
}) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const declared = data.layers.flatMap((l) =>
    (l.relationships ?? []).map((r) => ({ parent: l, rel: r })),
  );

  const setRelationships = (layerId: string, next: SublayerRelationship[]) =>
    onChange({
      ...data,
      layers: data.layers.map((l) =>
        l.id === layerId ? { ...l, relationships: next } : l,
      ),
    });

  return (
    <section className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-ink-0">
            <Link2 className="h-4 w-4" />
            {t('v3Relationships.heading')}
          </h3>
          <p className="text-xs text-muted">{t('v3Relationships.intro')}</p>
        </div>
        {canEdit && !adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('v3Relationships.add')}
          </button>
        ) : null}
      </div>

      {declared.length === 0 ? (
        <p className="text-xs italic text-muted">{t('v3Relationships.none')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {declared.map(({ parent, rel }) => (
            <li key={`${parent.id}:${rel.id}`} className="flex items-center gap-2 px-3 py-2 text-xs">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-ink-0">
                  {parent.label} → {rel.label}
                </p>
                <p className="truncate text-muted">
                  {rel.childItemId === itemId
                    ? t('v3Relationships.thisItem')
                    : rel.childItemId}{' '}
                  · {rel.childLayerId} · {rel.fkColumn}
                </p>
              </div>
              {canEdit ? (
                <button
                  type="button"
                  aria-label={t('v3Relationships.remove')}
                  onClick={() =>
                    setRelationships(
                      parent.id,
                      (parent.relationships ?? []).filter((r) => r.id !== rel.id),
                    )
                  }
                  className="rounded p-1 text-muted hover:bg-surface-2 hover:text-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <AddRelationship
          itemId={itemId}
          data={data}
          onCancel={() => setAdding(false)}
          onAdd={(parentId, rel) => {
            const parent = data.layers.find((l) => l.id === parentId);
            setRelationships(parentId, [...(parent?.relationships ?? []), rel]);
            setAdding(false);
          }}
        />
      ) : null}
    </section>
  );
}

function AddRelationship({
  itemId,
  data,
  onCancel,
  onAdd,
}: {
  itemId: string;
  data: DataLayerDataV3;
  onCancel: () => void;
  onAdd: (parentLayerId: string, rel: SublayerRelationship) => void;
}) {
  const t = useT();
  const [parentId, setParentId] = useState(data.layers[0]?.id ?? '');
  const [items, setItems] = useState<Array<{ id: string; title: string }> | null>(null);
  const [childItemId, setChildItemId] = useState('');
  const [childLayers, setChildLayers] = useState<DataLayerSublayer[] | null>(null);
  const [childLayerId, setChildLayerId] = useState('');
  const [fkColumn, setFkColumn] = useState('');
  const [label, setLabel] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  // Data layers the viewer can see. This item is listed first: a
  // relationship to one of its own tables is allowed too.
  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/portal/items?type=data_layer&lite=1', { signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((list: Item[]) => {
        const others = list
          .filter((i) => i.id !== itemId)
          .map((i) => ({ id: i.id, title: i.title }))
          .sort((a, b) => a.title.localeCompare(b.title));
        setItems([{ id: itemId, title: t('v3Relationships.thisItem') }, ...others]);
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') {
          setLoadError(t('v3Relationships.loadFailed'));
        }
      });
    return () => ctrl.abort();
  }, [itemId, t]);

  // The chosen item's tables. This item's come from the draft so a
  // table added but not yet saved can be picked.
  useEffect(() => {
    setChildLayers(null);
    setChildLayerId('');
    setFkColumn('');
    if (!childItemId) return;
    if (childItemId === itemId) {
      setChildLayers(data.layers);
      return;
    }
    const ctrl = new AbortController();
    fetch(`/api/portal/items/${childItemId}`, { signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((item: { data?: { version?: number; layers?: DataLayerSublayer[] } }) =>
        setChildLayers(item.data?.version === 3 ? (item.data.layers ?? []) : []),
      )
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') {
          setLoadError(t('v3Relationships.loadFailed'));
        }
      });
    return () => ctrl.abort();
  }, [childItemId, itemId, data.layers, t]);

  const tableOptions: LayerOption[] = useMemo(
    () =>
      (childLayers ?? [])
        .filter((l) => !(childItemId === itemId && l.id === parentId))
        .map((l) => ({ id: l.id, label: l.label || l.id })),
    [childLayers, childItemId, itemId, parentId],
  );
  const childLayer = childLayers?.find((l) => l.id === childLayerId);
  // The link column holds a UUID, so only text fields qualify.
  const fkOptions = (childLayer?.fields ?? []).filter((f) => f.type === 'string');

  const canSubmit = Boolean(parentId && childItemId && childLayerId && fkColumn);

  return (
    <div className="space-y-2 rounded-md border border-accent/30 bg-accent/5 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-ink-0">{t('v3Relationships.newHeading')}</p>
        <button
          type="button"
          aria-label={t('v3Relationships.cancel')}
          onClick={onCancel}
          className="rounded p-1 text-muted hover:bg-surface-2"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {loadError ? <p className="text-xs text-danger">{loadError}</p> : null}

      <Field label={t('v3Relationships.parentLayer')}>
        <select
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
          className={SELECT}
        >
          {data.layers.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label || l.id}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('v3Relationships.relatedItem')}>
        <select
          value={childItemId}
          onChange={(e) => setChildItemId(e.target.value)}
          disabled={items === null}
          className={SELECT}
        >
          <option value="">{items === null ? t('v3Relationships.loading') : t('v3Relationships.pick')}</option>
          {(items ?? []).map((i) => (
            <option key={i.id} value={i.id}>
              {i.title}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('v3Relationships.relatedTable')}>
        <select
          value={childLayerId}
          onChange={(e) => {
            setChildLayerId(e.target.value);
            setFkColumn('');
            const picked = childLayers?.find((l) => l.id === e.target.value);
            if (picked && !label) setLabel(picked.label || picked.id);
          }}
          disabled={!childLayers}
          className={SELECT}
        >
          <option value="">{t('v3Relationships.pick')}</option>
          {tableOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('v3Relationships.linkField')} hint={t('v3Relationships.linkFieldHint')}>
        <select
          value={fkColumn}
          onChange={(e) => setFkColumn(e.target.value)}
          disabled={!childLayer}
          className={SELECT}
        >
          <option value="">
            {childLayer && fkOptions.length === 0
              ? t('v3Relationships.noTextFields')
              : t('v3Relationships.pick')}
          </option>
          {fkOptions.map((f) => (
            <option key={f.name} value={f.name}>
              {f.label ? `${f.label} (${f.name})` : f.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('v3Relationships.label')}>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className={SELECT}
        />
      </Field>

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="h-8 rounded-md border border-border bg-surface-1 px-3 text-xs hover:bg-surface-2"
        >
          {t('v3Relationships.cancel')}
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() =>
            onAdd(parentId, {
              id: clientUuid(),
              label: label.trim() || childLayer?.label || childLayerId,
              childItemId,
              childLayerId,
              fkColumn,
            })
          }
          className="h-8 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
        >
          {t('v3Relationships.addConfirm')}
        </button>
      </div>
    </div>
  );
}

const SELECT =
  'h-8 w-full rounded border border-border bg-surface-1 px-2 text-xs text-ink-1 focus:border-accent focus:outline-hidden disabled:opacity-50';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-2xs uppercase tracking-wide text-muted">{label}</span>
      {children}
      {hint ? <span className="block text-2xs text-muted">{hint}</span> : null}
    </label>
  );
}
