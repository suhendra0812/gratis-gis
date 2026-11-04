// SPDX-License-Identifier: AGPL-3.0-or-later
import { isServerStampedField } from '@gratis-gis/shared-types';

/**
 * The fields of an attribute form whose value differs from the row as
 * it was loaded, for a PATCH that writes only what the person changed.
 *
 * Sending the whole form back would put every value as it was when
 * the form opened, silently undoing anyone else's edit to another
 * field in the meantime.
 *
 * Values are compared by JSON, so a re-entered array or object equal
 * in content is not a change. An empty input over a missing value is
 * not a change either. Server-maintained columns (`_global_id`,
 * `_edited_at`, `submitted_at`, ...) are never included.
 */
export function changedValues(
  initial: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (k.startsWith('_') || isServerStampedField(k)) continue;
    const before = initial[k];
    const same =
      before === v ||
      ((before === undefined || before === null) && (v === null || v === '')) ||
      JSON.stringify(before) === JSON.stringify(v);
    if (!same) out[k] = v;
  }
  return out;
}
