// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Source tab of the map builder's layer settings: where a layer's data
 * comes from, a link to it, and a way to point the layer somewhere
 * else, like "Change source" / "Replace layer" in ArcGIS Online.
 *
 * Links open in a new tab, so following one never discards unsaved
 * changes to the map.
 *
 * Changing the source keeps the layer: its style, labels, filter,
 * popup and position all stay, as in ArcGIS Online. When the new data
 * has other fields or another geometry, those settings may need a
 * look; the panel says so rather than resetting them. What it does
 * clear is what cannot survive the move: popup related tables of the
 * old data layer, and a relate (`via`) keyed to the old rows.
 */

import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Loader2, Search } from 'lucide-react';
import type { Item, MapLayer, MapLayerSource } from '@gratis-gis/shared-types';
import { useT } from '@/lib/i18n/locale-context';

type LiteDataLayer = Item & {
  _layers?: Array<{ id: string; label: string; geometryType: string | null }>;
};

/** Source kinds whose data a vector layer can be re-pointed to a data layer from. */
const VECTOR_KINDS: ReadonlySet<MapLayerSource['kind']> = new Set([
  'data-layer',
  'geojson-url',
  'geojson-inline',
  'arcgis-rest',
]);

export function LayerSourcePanel({
  layer,
  canEdit,
  geometryTypes,
  onPatch,
}: {
  layer: MapLayer;
  canEdit: boolean;
  /** Geometry types the layer's data currently has, when known. */
  geometryTypes?: ReadonlySet<string> | undefined;
  onPatch: (patch: Partial<MapLayer>) => void;
}) {
  const t = useT();
  const source = layer.source;
  const [changing, setChanging] = useState(false);

  return (
    <div className="space-y-3 px-3 py-3 text-xs">
      <SourceDetails source={source} />

      {canEdit && source.kind !== 'group' ? (
        changing ? (
          <ChangeSource
            layer={layer}
            geometryTypes={geometryTypes}
            onCancel={() => setChanging(false)}
            onApply={(next) => {
              onPatch(applySourceChange(layer, next));
              setChanging(false);
            }}
          />
        ) : canChange(source) ? (
          <button
            type="button"
            onClick={() => setChanging(true)}
            className="inline-flex h-8 w-full items-center justify-center rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2"
          >
            {t('mapLayerSource.change')}
          </button>
        ) : (
          <p className="text-2xs text-muted">{t('mapLayerSource.cannotChange')}</p>
        )
      ) : null}
    </div>
  );
}

function canChange(source: MapLayerSource): boolean {
  return VECTOR_KINDS.has(source.kind);
}

/**
 * The layer patch for a new source. Settings stay; only what is tied
 * to the old data and would be wrong for the new one is dropped.
 */
export function applySourceChange(layer: MapLayer, next: MapLayerSource): Partial<MapLayer> {
  const patch: Partial<MapLayer> = { source: next };
  const oldItem = layer.source.kind === 'data-layer' ? layer.source.itemId : null;
  const newItem = next.kind === 'data-layer' ? next.itemId : null;
  if (layer.popup.related && oldItem !== newItem) {
    // In-item related tables belong to the old data layer; entries
    // that name their own item stay valid.
    const kept = layer.popup.related.filter((r) => r.itemId !== undefined);
    patch.popup = { ...layer.popup, related: kept };
  }
  return patch;
}

// ---- Details ---------------------------------------------------------

function SourceDetails({ source }: { source: MapLayerSource }) {
  const t = useT();
  switch (source.kind) {
    case 'data-layer':
      return <DataLayerDetails itemId={source.itemId} layerKey={source.layerKey} />;
    case 'arcgis-rest':
      return (
        <Details kind={t('mapLayerSource.kind.arcgis')}>
          <Row label={t('mapLayerSource.url')} value={source.url} mono />
          <Row label={t('mapLayerSource.layerId')} value={String(source.layerId)} />
          <Row label={t('mapLayerSource.serviceType')} value={source.serviceType} />
          <LinkOut href={`${source.url.replace(/\/+$/, '')}/${source.layerId}`}>
            {t('mapLayerSource.openService')}
          </LinkOut>
          {source.sourceItemId ? (
            <LinkOut href={`/items/${source.sourceItemId}`}>{t('mapLayerSource.openItem')}</LinkOut>
          ) : null}
        </Details>
      );
    case 'geojson-url':
      return (
        <Details kind={t('mapLayerSource.kind.geojsonUrl')}>
          <Row label={t('mapLayerSource.url')} value={source.url} mono />
          <LinkOut href={source.url}>{t('mapLayerSource.openUrl')}</LinkOut>
        </Details>
      );
    case 'geojson-inline': {
      const n = Array.isArray((source.geojson as { features?: unknown[] } | null)?.features)
        ? (source.geojson as { features: unknown[] }).features.length
        : null;
      return (
        <Details kind={t('mapLayerSource.kind.geojsonInline')}>
          <p className="text-muted">{t('mapLayerSource.inlineNote')}</p>
          {n !== null ? (
            <Row label={t('mapLayerSource.features')} value={String(n)} />
          ) : null}
        </Details>
      );
    }
    case 'postgis-live':
      return (
        <Details kind={t('mapLayerSource.kind.postgis')}>
          <Row label={t('mapLayerSource.table')} value={source.tableName} mono />
          {source.whereClause ? (
            <Row label={t('mapLayerSource.where')} value={source.whereClause} mono />
          ) : null}
          <LinkOut href={`/items/${source.serviceItemId}`}>
            {t('mapLayerSource.openConnection')}
          </LinkOut>
        </Details>
      );
    case 'point-cloud':
      return (
        <Details kind={t('mapLayerSource.kind.pointCloud')}>
          <LinkOut href={`/items/${source.itemId}`}>{t('mapLayerSource.openItem')}</LinkOut>
        </Details>
      );
    case 'tile':
      return (
        <Details kind={t('mapLayerSource.kind.tile')}>
          <LinkOut href={`/items/${source.itemId}`}>{t('mapLayerSource.openItem')}</LinkOut>
        </Details>
      );
    case 'group':
      return <p className="text-muted">{t('mapLayerSource.groupNote')}</p>;
    default: {
      const _never: never = source;
      void _never;
      return null;
    }
  }
}

function DataLayerDetails({ itemId, layerKey }: { itemId: string; layerKey?: string | undefined }) {
  const t = useT();
  const [info, setInfo] = useState<{
    title: string;
    sublayer: string | null;
    geometry: string | null;
    count: number | null;
  } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setInfo(null);
    setFailed(false);
    fetch(`/api/portal/items/${itemId}`, { signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then(
        (item: {
          title: string;
          data?: {
            layers?: Array<{
              id: string;
              label: string;
              geometryType: string | null;
              featureCount?: number;
            }>;
          };
        }) => {
          const sub = layerKey ? item.data?.layers?.find((l) => l.id === layerKey) : undefined;
          setInfo({
            title: item.title,
            sublayer: sub ? sub.label || sub.id : (layerKey ?? null),
            geometry: sub ? (sub.geometryType ?? 'table') : null,
            count: typeof sub?.featureCount === 'number' ? sub.featureCount : null,
          });
        },
      )
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') setFailed(true);
      });
    return () => ctrl.abort();
  }, [itemId, layerKey]);

  return (
    <Details kind={t('mapLayerSource.kind.dataLayer')}>
      {failed ? (
        <p className="text-danger">{t('mapLayerSource.loadFailed')}</p>
      ) : info === null ? (
        <p className="flex items-center gap-1 text-muted">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('mapLayerSource.loading')}
        </p>
      ) : (
        <>
          <Row label={t('mapLayerSource.item')} value={info.title} />
          {info.sublayer ? <Row label={t('mapLayerSource.sublayer')} value={info.sublayer} /> : null}
          {info.geometry ? <Row label={t('mapLayerSource.geometry')} value={info.geometry} /> : null}
          {info.count !== null ? (
            <Row label={t('mapLayerSource.features')} value={info.count.toLocaleString()} />
          ) : null}
        </>
      )}
      <LinkOut href={`/items/${itemId}`}>{t('mapLayerSource.openDataLayer')}</LinkOut>
    </Details>
  );
}

function Details({ kind, children }: { kind: string; children: React.ReactNode }) {
  const t = useT();
  return (
    <section className="space-y-1.5 rounded-md border border-border bg-surface-1 p-2.5">
      <p className="text-2xs uppercase tracking-wide text-muted">
        {t('mapLayerSource.heading')} · <span className="font-medium text-ink-1">{kind}</span>
      </p>
      {children}
    </section>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
      <span className="text-muted">{label}</span>
      <span className={`break-all text-ink-0 ${mono ? 'font-mono text-2xs' : ''}`}>{value}</span>
    </div>
  );
}

function LinkOut({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
    >
      {children}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

// ---- Change source ---------------------------------------------------

type Mode = 'data-layer' | 'url';

function ChangeSource({
  layer,
  geometryTypes,
  onCancel,
  onApply,
}: {
  layer: MapLayer;
  geometryTypes?: ReadonlySet<string> | undefined;
  onCancel: () => void;
  onApply: (next: MapLayerSource) => void;
}) {
  const t = useT();
  const source = layer.source;
  const urlKind = source.kind === 'arcgis-rest' || source.kind === 'geojson-url';
  const [mode, setMode] = useState<Mode>(urlKind ? 'url' : 'data-layer');

  return (
    <section className="space-y-2 rounded-md border border-accent/40 bg-accent/5 p-2.5">
      <p className="text-xs font-medium text-ink-0">{t('mapLayerSource.changeHeading')}</p>
      {urlKind ? (
        <div className="flex gap-1" role="group">
          {(['url', 'data-layer'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={`h-7 flex-1 rounded border px-2 text-2xs font-medium ${
                mode === m
                  ? 'border-accent bg-accent text-accent-foreground'
                  : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
              }`}
            >
              {m === 'url' ? t('mapLayerSource.modeUrl') : t('mapLayerSource.modeDataLayer')}
            </button>
          ))}
        </div>
      ) : null}
      {mode === 'url' && urlKind ? (
        <UrlChange source={source} onCancel={onCancel} onApply={onApply} />
      ) : (
        <DataLayerPicker
          current={source.kind === 'data-layer' ? source : null}
          geometryTypes={geometryTypes}
          onCancel={onCancel}
          onApply={onApply}
        />
      )}
      <p className="text-2xs text-muted">{t('mapLayerSource.keepsSettings')}</p>
    </section>
  );
}

function UrlChange({
  source,
  onCancel,
  onApply,
}: {
  source: Extract<MapLayerSource, { kind: 'arcgis-rest' } | { kind: 'geojson-url' }>;
  onCancel: () => void;
  onApply: (next: MapLayerSource) => void;
}) {
  const t = useT();
  const [url, setUrl] = useState(source.url);
  const [layerId, setLayerId] = useState(
    source.kind === 'arcgis-rest' ? String(source.layerId) : '',
  );
  const validUrl = /^https?:\/\/\S+$/i.test(url.trim());
  const validId = source.kind !== 'arcgis-rest' || /^\d+$/.test(layerId.trim());
  const unchanged =
    url.trim() === source.url &&
    (source.kind !== 'arcgis-rest' || Number(layerId) === source.layerId);

  return (
    <div className="space-y-2">
      <label className="block space-y-1">
        <span className="text-2xs uppercase tracking-wide text-muted">
          {source.kind === 'arcgis-rest' ? t('mapLayerSource.serviceUrl') : t('mapLayerSource.url')}
        </span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="h-8 w-full rounded border border-border bg-surface-1 px-2 font-mono text-2xs text-ink-1 focus:border-accent focus:outline-hidden"
        />
      </label>
      {source.kind === 'arcgis-rest' ? (
        <label className="block space-y-1">
          <span className="text-2xs uppercase tracking-wide text-muted">{t('mapLayerSource.layerId')}</span>
          <input
            value={layerId}
            inputMode="numeric"
            onChange={(e) => setLayerId(e.target.value)}
            className="h-8 w-24 rounded border border-border bg-surface-1 px-2 text-xs text-ink-1 focus:border-accent focus:outline-hidden"
          />
        </label>
      ) : null}
      {!validUrl || !validId ? (
        <p className="text-2xs text-danger">{t('mapLayerSource.invalidUrl')}</p>
      ) : null}
      <Actions
        canApply={validUrl && validId && !unchanged}
        onCancel={onCancel}
        onApply={() =>
          onApply(
            source.kind === 'arcgis-rest'
              ? { ...source, url: url.trim().replace(/\/+$/, ''), layerId: Number(layerId) }
              : { ...source, url: url.trim() },
          )
        }
      />
    </div>
  );
}

function DataLayerPicker({
  current,
  geometryTypes,
  onCancel,
  onApply,
}: {
  current: Extract<MapLayerSource, { kind: 'data-layer' }> | null;
  geometryTypes?: ReadonlySet<string> | undefined;
  onCancel: () => void;
  onApply: (next: MapLayerSource) => void;
}) {
  const t = useT();
  const [items, setItems] = useState<LiteDataLayer[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState('');
  const [itemId, setItemId] = useState(current?.itemId ?? '');
  const [layerKey, setLayerKey] = useState(current?.layerKey ?? '');

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/portal/items?type=data_layer&lite=1', { signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((list: LiteDataLayer[]) =>
        setItems([...list].sort((a, b) => a.title.localeCompare(b.title))),
      )
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') setFailed(true);
      });
    return () => ctrl.abort();
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? []).filter((i) => !needle || i.title.toLowerCase().includes(needle));
  }, [items, q]);
  const picked = items?.find((i) => i.id === itemId);
  const sublayers = picked?._layers ?? [];
  const sub = sublayers.find((l) => l.id === layerKey);

  // A different geometry still draws, but the style was made for the
  // old one; say so instead of silently changing how it looks.
  const currentGeom = geometryTypes && geometryTypes.size > 0 ? [...geometryTypes] : [];
  const geomMismatch =
    sub !== undefined &&
    currentGeom.length > 0 &&
    !currentGeom.some((g) => g.toLowerCase().includes(String(sub.geometryType ?? 'table').toLowerCase()));

  const needsSublayer = sublayers.length > 0;
  const canApply =
    Boolean(itemId) &&
    (!needsSublayer || Boolean(sub)) &&
    !(current && current.itemId === itemId && (current.layerKey ?? '') === layerKey);

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-1.5 rounded border border-border bg-surface-1 px-2">
        <Search className="h-3.5 w-3.5 text-muted" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('mapLayerSource.searchDataLayers')}
          aria-label={t('mapLayerSource.searchDataLayers')}
          className="h-8 min-w-0 flex-1 bg-transparent text-xs text-ink-1 focus:outline-hidden"
        />
      </label>
      {failed ? (
        <p className="text-2xs text-danger">{t('mapLayerSource.loadFailed')}</p>
      ) : items === null ? (
        <p className="flex items-center gap-1 text-2xs text-muted">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('mapLayerSource.loading')}
        </p>
      ) : (
        <ul
          role="listbox"
          aria-label={t('mapLayerSource.modeDataLayer')}
          className="max-h-40 divide-y divide-border overflow-y-auto rounded border border-border bg-surface-1"
        >
          {shown.length === 0 ? (
            <li className="px-2 py-1.5 text-2xs italic text-muted">{t('mapLayerSource.noMatches')}</li>
          ) : (
            shown.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i.id === itemId}
                  onClick={() => {
                    setItemId(i.id);
                    const first = i._layers?.find((l) => l.geometryType !== null) ?? i._layers?.[0];
                    setLayerKey(first?.id ?? '');
                  }}
                  className={`block w-full truncate px-2 py-1.5 text-left text-xs ${
                    i.id === itemId ? 'bg-accent/10 font-medium text-ink-0' : 'text-ink-1 hover:bg-surface-2'
                  }`}
                >
                  {i.title}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
      {needsSublayer ? (
        <label className="block space-y-1">
          <span className="text-2xs uppercase tracking-wide text-muted">{t('mapLayerSource.sublayer')}</span>
          <select
            value={layerKey}
            onChange={(e) => setLayerKey(e.target.value)}
            className="h-8 w-full rounded border border-border bg-surface-1 px-2 text-xs text-ink-1 focus:border-accent focus:outline-hidden"
          >
            {sublayers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label || l.id} ({l.geometryType ?? t('mapLayerSource.tableKind')})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {geomMismatch ? (
        <p className="text-2xs text-warn">
          {t('mapLayerSource.geometryMismatch', {
            from: currentGeom.join(' + '),
            to: String(sub?.geometryType ?? t('mapLayerSource.tableKind')),
          })}
        </p>
      ) : null}
      <Actions
        canApply={canApply}
        onCancel={onCancel}
        onApply={() =>
          onApply({
            kind: 'data-layer',
            itemId,
            ...(needsSublayer && layerKey ? { layerKey } : {}),
          })
        }
      />
    </div>
  );
}

function Actions({
  canApply,
  onCancel,
  onApply,
}: {
  canApply: boolean;
  onCancel: () => void;
  onApply: () => void;
}) {
  const t = useT();
  return (
    <div className="flex justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="h-7 rounded border border-border bg-surface-1 px-3 text-xs text-ink-1 hover:bg-surface-2"
      >
        {t('mapLayerSource.cancel')}
      </button>
      <button
        type="button"
        disabled={!canApply}
        onClick={onApply}
        className="h-7 rounded bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
      >
        {t('mapLayerSource.apply')}
      </button>
    </div>
  );
}
