// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What a map popup can show for one attribute value, and how it
 * reads a feature's attachment list.
 *
 * Form submission layers store some answers as structured values: a
 * geopoint is `{ lat, lng, accuracy }`, and a photo or signature
 * question holds an array of attachment descriptors
 * (`{ url, key, name, mimeType, sizeBytes }`). Stringifying those in
 * an attribute row printed "[object Object]". The point is already
 * the feature's geometry and the files are reachable through the
 * popup's attachments section, so the attribute list leaves them out.
 */

/**
 * Display text for one attribute value, or null when the popup
 * should skip the row: empty values, objects, and arrays holding
 * anything other than plain text or numbers. An array of text or
 * numbers (a select-multiple answer) joins with commas.
 */
export function popupDisplayValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'string' || typeof v === 'number')
  ) {
    return value.join(', ');
  }
  return null;
}

/**
 * True when a value is structured (an object, or an array holding
 * one). Popup field pickers hide such fields because the popup
 * cannot print them.
 */
export function isStructuredValue(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (!Array.isArray(value)) return true;
  return value.some((v) => v !== null && typeof v === 'object');
}

/** One file attached to a feature, as the popup lists it. */
export interface PopupAttachment {
  id: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  url: string;
}

/**
 * Parse the feature attachments endpoint's body. Rows without a
 * usable name or a same-origin storage URL are dropped, so a popup
 * never links somewhere the portal did not put the file.
 */
export function parsePopupAttachments(body: unknown): PopupAttachment[] {
  if (!Array.isArray(body)) return [];
  const out: PopupAttachment[] = [];
  for (const row of body) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const url = typeof r.storageUrl === 'string' ? r.storageUrl : '';
    if (!url.startsWith('/api/portal/storage/')) continue;
    const fileName = typeof r.fileName === 'string' && r.fileName ? r.fileName : null;
    if (!fileName) continue;
    out.push({
      id: typeof r.id === 'string' ? r.id : url,
      fileName,
      mime: typeof r.mime === 'string' ? r.mime : 'application/octet-stream',
      sizeBytes: typeof r.sizeBytes === 'number' && r.sizeBytes >= 0 ? r.sizeBytes : 0,
      url,
    });
  }
  return out;
}

/** Image types a browser renders inline as a thumbnail. */
export function isImageAttachment(mime: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(mime);
}
