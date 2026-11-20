// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Field options shared by the join tools (spatial-join and
 * attribute-join): which input fields carry over (`keepFields`) and
 * display labels for the output fields (`aliases`).
 */
import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

export const FIELD_NAME_RE = /^[a-z_][a-z0-9_]*$/i;
export const MAX_ALIAS_LENGTH = 120;

/** Names of the joined columns the step adds. */
export function joinedNames(
  strategy: 'count' | 'first',
  attrs: string[] | undefined,
  prefix: string,
): string[] {
  return strategy === 'count'
    ? [`${prefix}count`]
    : (attrs ?? []).map((a) => `${prefix}${a}`);
}

/** The input fields that carry over. Unset keeps all of them. */
export function keptSchema(
  input: FeatureField[],
  keepFields: string[] | undefined,
): FeatureField[] {
  return keepFields ? input.filter((f) => keepFields.includes(f.name)) : input;
}

/** Validates `keepFields`, checked against the input when it is known. */
export function validateKeepFields(
  tool: string,
  raw: unknown,
  sourceSchema: FeatureField[] | undefined,
): string[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) {
    throw new BadRequestException(
      `${tool}.params.keepFields must be an array of input field names`,
    );
  }
  const list: string[] = [];
  for (const f of raw) {
    if (typeof f !== 'string' || !FIELD_NAME_RE.test(f)) {
      throw new BadRequestException(
        `${tool}.params.keepFields entries must match ${FIELD_NAME_RE}`,
      );
    }
    if (sourceSchema && !sourceSchema.some((s) => s.name === f)) {
      throw new BadRequestException(
        `${tool}.params.keepFields: "${f}" is not a field of the input`,
      );
    }
    if (!list.includes(f)) list.push(f);
  }
  return list;
}

/**
 * Validates `aliases`. Aliases only relabel output fields. When the
 * output names are known, ones for fields the step no longer outputs
 * are dropped, so unticking a field never blocks a save.
 */
export function validateAliases(
  tool: string,
  raw: unknown,
  outNames: Set<string> | null,
): Record<string, string> | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException(
      `${tool}.params.aliases must be an object of output field name to label`,
    );
  }
  const out: Record<string, string> = {};
  for (const [name, label] of Object.entries(raw as Record<string, unknown>)) {
    if (!FIELD_NAME_RE.test(name) || typeof label !== 'string') {
      throw new BadRequestException(
        `${tool}.params.aliases must map field names to text labels`,
      );
    }
    const trimmed = label.trim();
    if (trimmed.length > MAX_ALIAS_LENGTH) {
      throw new BadRequestException(
        `${tool}.params.aliases: the label for "${name}" is longer than ${MAX_ALIAS_LENGTH} characters`,
      );
    }
    if (trimmed && (!outNames || outNames.has(name))) out[name] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Rejects joined names that clash with an input field that carries over. */
export function assertNoClash(
  tool: string,
  kept: FeatureField[],
  joined: string[],
): void {
  for (const name of joined) {
    if (kept.some((f) => f.name === name)) {
      throw new BadRequestException(
        `${tool} would create output column "${name}" but the upstream schema already has it; pick a different attrPrefix`,
      );
    }
  }
}

/** Kept input fields plus the joined ones, with aliases as labels. */
export function joinOutputSchema(
  input: FeatureField[],
  params: {
    keepFields?: string[];
    attributeStrategy: 'count' | 'first';
    attrsToKeep?: string[];
    attrPrefix?: string;
    aliases?: Record<string, string>;
  },
  defaultPrefix: string,
): FeatureField[] {
  const prefix = params.attrPrefix ?? defaultPrefix;
  const joined: FeatureField[] =
    params.attributeStrategy === 'count'
      ? [{ name: `${prefix}count`, label: `${prefix}count`, type: 'number', nullable: false }]
      : (params.attrsToKeep ?? []).map((a) => ({
          name: `${prefix}${a}`,
          label: `${prefix}${a}`,
          type: 'string' as const,
          nullable: true,
        }));
  const aliases = params.aliases ?? {};
  return [...keptSchema(input, params.keepFields), ...joined].map((f) =>
    aliases[f.name] ? { ...f, label: aliases[f.name]! } : f,
  );
}

/**
 * SQL for the left row's properties cut down to `keepFields`. The
 * caller reads its join key from `l.properties` directly, so a key that
 * is not kept still works. `ph` adds a bound parameter.
 */
export function keptPropsSql(
  keepFields: string[] | undefined,
  ph: (v: unknown) => string,
): string {
  return keepFields
    ? `COALESCE((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(l.properties) e
         WHERE e.key = ANY(${ph(keepFields)}::text[])), '{}'::jsonb)`
    : 'l.properties';
}
