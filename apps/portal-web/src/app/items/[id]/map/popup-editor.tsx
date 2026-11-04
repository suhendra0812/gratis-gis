// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useMemo } from 'react';
import { ArrowDown, ArrowUp, Trash2, X } from 'lucide-react';
import {
  POPUP_RELATED_DEFAULT_ROWS,
  POPUP_RELATED_MAX_ROWS,
  type MapLayerPopup,
  type MapLayerPopupRelated,
  type MapLayerSource,
} from '@gratis-gis/shared-types';
import type { LayerMetadata } from './layer-metadata';
import { TemplateInput } from './template-input';
import { useChildTables } from './related-tables';
import { useT } from '@/lib/i18n/locale-context';

interface Props {
  value: MapLayerPopup;
  metadata: LayerMetadata;
  onChange: (next: MapLayerPopup) => void;
  /** The layer's source; related records need a v3 data-layer sublayer. */
  source?: MapLayerSource | undefined;
}

/**
 * Click-popup editor with three body modes:
 *
 *   - All fields: list every property on the feature (zero config).
 *   - Picked fields: ordered allow-list of fields.
 *   - Template: hand-written Handlebars-lite string with {{field}}
 *     interpolation and optional `| formatter` pipes. A live preview
 *     renders against a real feature pulled from layer metadata.
 *
 * Mixed-mode popups (custom title + picked body, etc.) fall out
 * naturally from the independent title template + body mode knobs.
 */
export function PopupEditor({ value, metadata, onChange, source }: Props) {
  const t = useT();

  function patch(p: Partial<MapLayerPopup>) {
    onChange({ ...value, ...p });
  }

  // The popup-trigger toggles ("Click shows popup", "Popup on
  // hover") live in the Interactions section now (they're behavior
  // toggles; this section is content configuration). When neither
  // trigger is on the section renders an empty-state nudge instead
  // of the title/body editors so a no-op section doesn't sit
  // open with no effect.
  const triggerActive = value.enabled || value.showOnHover === true;

  return (
    <div className="space-y-3">
      {!triggerActive ? (
        <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
          {t('mapPopupEditor.popupsOffPrefix')}{' '}
          <em>{t('mapLayerPanel.toggles.clickShowsPopup')}</em>{' '}
          {t('mapPopupEditor.popupsOffOr')}{' '}
          <em>{t('mapLayerPanel.toggles.popupOnHover')}</em>{' '}
          {t('mapPopupEditor.popupsOffSuffix')}
        </p>
      ) : (
        <>
          <TitleEditor value={value} metadata={metadata} onPatch={patch} />

          <div>
            <label className="mb-2 block text-2xs uppercase tracking-wide text-muted">
              {t('mapPopupEditor.body')}
            </label>
            <div className="grid grid-cols-3 gap-2">
              <ModeBtn
                active={value.mode === 'all'}
                onClick={() => patch({ mode: 'all' })}
                label={t('mapPopupEditor.modeAll')}
              />
              <ModeBtn
                active={value.mode === 'picked'}
                onClick={() => patch({ mode: 'picked' })}
                label={t('mapPopupEditor.modePicked')}
              />
              <ModeBtn
                active={value.mode === 'template'}
                onClick={() => patch({ mode: 'template' })}
                label={t('mapPopupEditor.modeTemplate')}
              />
            </div>
          </div>

          {value.mode === 'picked' ? (
            <PickedEditor value={value} metadata={metadata} onPatch={patch} />
          ) : null}
          {value.mode === 'template' ? (
            <TemplateEditor value={value} metadata={metadata} onPatch={patch} />
          ) : null}

          {source?.kind === 'data-layer' && source.layerKey ? (
            <RelatedEditor
              value={value}
              itemId={source.itemId}
              layerKey={source.layerKey}
              onPatch={patch}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Related records: child tables of this sublayer (same data_layer
 * item, `parentLayerId` pointing here) that the popup lists under the
 * attributes. Children are discovered from the item, so a layer with
 * none shows a one-line note instead of an empty picker.
 */
function RelatedEditor({
  value,
  itemId,
  layerKey,
  onPatch,
}: {
  value: MapLayerPopup;
  itemId: string;
  layerKey: string;
  onPatch: (p: Partial<MapLayerPopup>) => void;
}) {
  const t = useT();
  const { children, failed } = useChildTables(itemId, layerKey);

  const related = value.related ?? [];
  const setRelated = (next: MapLayerPopupRelated[]) => onPatch({ related: next });

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <label className="block text-2xs uppercase tracking-wide text-muted">
        {t('mapPopupRelated.heading')}
      </label>
      {failed ? (
        <p className="text-2xs text-danger">{t('mapPopupRelated.loadFailed')}</p>
      ) : children === null ? (
        <p className="text-2xs text-muted">{t('mapPopupEditor.loading')}</p>
      ) : children.length === 0 ? (
        <p className="text-2xs text-muted">{t('mapPopupRelated.noChildren')}</p>
      ) : (
        <ul className="space-y-2">
          {children.map((child) => {
            const cfg = related.find((r) => r.layerKey === child.id);
            const childFields = child.fields
              .map((f) => f.name)
              .filter((n) => n !== child.parentFkColumn);
            return (
              <li key={child.id} className="rounded-md border border-border bg-surface-1 p-2">
                <label className="flex items-center gap-2 text-xs text-ink-1">
                  <input
                    type="checkbox"
                    checked={cfg !== undefined}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setRelated([
                          ...related,
                          {
                            layerKey: child.id,
                            label: child.label,
                            fkColumn: child.parentFkColumn!,
                            fields: [],
                            limit: POPUP_RELATED_DEFAULT_ROWS,
                          },
                        ]);
                      } else {
                        setRelated(related.filter((r) => r.layerKey !== child.id));
                      }
                    }}
                  />
                  <span className="font-medium">{child.label}</span>
                </label>
                {cfg ? (
                  <RelatedRowSettings
                    cfg={cfg}
                    fields={childFields}
                    onChange={(next) =>
                      setRelated(related.map((r) => (r.layerKey === child.id ? next : r)))
                    }
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RelatedRowSettings({
  cfg,
  fields,
  onChange,
}: {
  cfg: MapLayerPopupRelated;
  fields: string[];
  onChange: (next: MapLayerPopupRelated) => void;
}) {
  const t = useT();
  const unpicked = fields.filter((f) => !cfg.fields.includes(f));
  return (
    <div className="mt-2 space-y-2 pl-6">
      <div>
        <span className="mb-1 block text-2xs text-muted">{t('mapPopupRelated.fields')}</span>
        <div className="flex flex-wrap gap-1">
          {cfg.fields.length === 0 ? (
            <span className="text-2xs italic text-muted">{t('mapPopupRelated.fieldsDefault')}</span>
          ) : (
            cfg.fields.map((f) => (
              <span
                key={f}
                className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-1"
              >
                {f}
                <button
                  type="button"
                  aria-label={t('mapPopupEditor.removeFieldAria')}
                  onClick={() => onChange({ ...cfg, fields: cfg.fields.filter((x) => x !== f) })}
                  className="text-muted hover:text-danger"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))
          )}
        </div>
        <select
          value=""
          onChange={(e) => {
            const f = e.target.value;
            if (f) onChange({ ...cfg, fields: [...cfg.fields, f] });
          }}
          disabled={unpicked.length === 0}
          aria-label={t('mapLayerPanel.search.addField')}
          className="mt-1 h-7 w-full rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden disabled:opacity-50"
        >
          <option value="">
            {unpicked.length === 0
              ? t('mapLayerPanel.search.allFieldsAdded')
              : t('mapLayerPanel.search.addField')}
          </option>
          {unpicked.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-2 text-2xs text-muted">
        {t('mapPopupRelated.maxRows')}
        <input
          type="number"
          min={1}
          max={POPUP_RELATED_MAX_ROWS}
          value={cfg.limit}
          onChange={(e) => {
            const n = Math.min(
              Math.max(Math.floor(Number(e.target.value)) || 1, 1),
              POPUP_RELATED_MAX_ROWS,
            );
            onChange({ ...cfg, limit: n });
          }}
          className="h-7 w-16 rounded border border-border bg-surface-1 px-2 text-xs text-ink-1 focus:border-accent focus:outline-hidden"
        />
      </label>
    </div>
  );
}

function TitleEditor({
  value,
  metadata,
  onPatch,
}: {
  value: MapLayerPopup;
  metadata: LayerMetadata;
  onPatch: (p: Partial<MapLayerPopup>) => void;
}) {
  const t = useT();
  const sample = useMemo(
    () => metadata.sampleProperties ?? synthesizeSample(metadata),
    [metadata],
  );
  return (
    <div>
      <label className="mb-1 block text-2xs uppercase tracking-wide text-muted">
        {t('mapPopupEditor.titleTemplate')}
      </label>
      <TemplateInput
        value={value.titleTemplate}
        onChange={(next) => onPatch({ titleTemplate: next })}
        fields={metadata.fields}
        sampleProperties={sample}
        placeholder={t('mapPopupEditor.titlePlaceholder')}
      />
    </div>
  );
}

function PickedEditor({
  value,
  metadata,
  onPatch,
}: {
  value: MapLayerPopup;
  metadata: LayerMetadata;
  onPatch: (p: Partial<MapLayerPopup>) => void;
}) {
  const t = useT();

  function moveField(idx: number, dir: -1 | 1) {
    const target = idx + dir;
    if (target < 0 || target >= value.fields.length) return;
    const next = [...value.fields];
    const tmp = next[idx]!;
    next[idx] = next[target]!;
    next[target] = tmp;
    onPatch({ fields: next });
  }
  function removeField(idx: number) {
    onPatch({ fields: value.fields.filter((_, i) => i !== idx) });
  }
  function addField(name: string) {
    if (!name || value.fields.includes(name)) return;
    onPatch({ fields: [...value.fields, name] });
  }
  const unpicked = metadata.fields.filter((f) => !value.fields.includes(f));

  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-1 p-2">
      {value.fields.length === 0 ? (
        <p className="text-2xs text-muted">{t('mapPopupEditor.noFieldsYet')}</p>
      ) : (
        <ul className="space-y-1">
          {value.fields.map((f, i) => (
            <li key={f} className="flex items-center gap-1">
              <span className="flex-1 truncate text-xs">{f}</span>
              <button
                type="button"
                onClick={() => moveField(i, -1)}
                disabled={i === 0}
                aria-label={t('mapPopupEditor.moveUpAria')}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:opacity-30"
              >
                <ArrowUp className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => moveField(i, 1)}
                disabled={i === value.fields.length - 1}
                aria-label={t('mapPopupEditor.moveDownAria')}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:opacity-30"
              >
                <ArrowDown className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => removeField(i)}
                aria-label={t('mapPopupEditor.removeFieldAria')}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-danger"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        {metadata.fields.length > 0 ? (
          <select
            value=""
            onChange={(e) => {
              addField(e.target.value);
              e.target.value = '';
            }}
            disabled={unpicked.length === 0}
            className="h-8 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden focus:ring-1 focus:ring-accent/30 disabled:opacity-50"
          >
            <option value="">
              {unpicked.length === 0
                ? t('mapLayerPanel.search.allFieldsAdded')
                : t('mapLayerPanel.search.addField')}
            </option>
            {unpicked.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            placeholder={t('mapLayerPanel.search.fieldNamePlaceholder')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                addField((e.target as HTMLInputElement).value.trim());
                (e.target as HTMLInputElement).value = '';
              }
            }}
            className="h-8 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden focus:ring-1 focus:ring-accent/30"
          />
        )}
        {metadata.loading ? (
          <span className="self-center text-2xs text-muted">
            {t('mapPopupEditor.loading')}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function TemplateEditor({
  value,
  metadata,
  onPatch,
}: {
  value: MapLayerPopup;
  metadata: LayerMetadata;
  onPatch: (p: Partial<MapLayerPopup>) => void;
}) {
  const t = useT();
  // Live preview: render the body against a sample feature, falling
  // back to a synthetic one if the layer hasn't loaded any yet.
  const sample = useMemo(
    () => metadata.sampleProperties ?? synthesizeSample(metadata),
    [metadata],
  );

  return (
    <div className="space-y-2">
      <TemplateInput
        value={value.bodyTemplate}
        onChange={(next) => onPatch({ bodyTemplate: next })}
        fields={metadata.fields}
        sampleProperties={sample}
        placeholder={t('mapPopupEditor.bodyPlaceholder')}
        multiline
        rows={6}
        previewAsHtml
        extraInserts={[
          { label: t('mapPopupEditor.lineBreakInsert'), insert: '<br>' },
        ]}
      />
      <p className="text-2xs text-muted">
        <code className="rounded bg-surface-2 px-1">{`{{field}}`}</code>{' '}
        {t('mapPopupEditor.templateFieldReads')}{' '}
        <code className="rounded bg-surface-2 px-1">
          {t('mapPopupEditor.fieldFmtExample')}
        </code>{' '}
        {t('mapPopupEditor.templateFmtFormats')}
      </p>
    </div>
  );
}

function ModeBtn({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border p-2 text-xs font-medium transition-colors ${
        active
          ? 'border-accent bg-accent/5 text-ink-0 ring-2 ring-accent/30'
          : 'border-border bg-surface-1 text-muted hover:bg-surface-2'
      }`}
    >
      {label}
    </button>
  );
}

/**
 * Build a sample feature for the live preview when the canvas hasn't
 * loaded a real one yet.  Each known field gets either the first
 * cached value or a `<field>` placeholder so the template renders
 * readably while the author is typing.
 */
function synthesizeSample(metadata: LayerMetadata): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of metadata.fields) {
    out[f] = metadata.valuesByField[f]?.[0] ?? `<${f}>`;
  }
  return out;
}
