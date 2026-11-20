// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import {
  ATTRIBUTE_JOIN_FEATURE_ID,
  type AttributeJoinStep,
  type FeatureField,
} from '@gratis-gis/shared-types';

import {
  dataLayerScope,
  dataLayerSourceSqlFragment,
} from '../../engine/data-layer.js';
import type {
  ToolDependencies,
  ToolGenerator,
  ToolValidateContext,
} from './types.js';
import { numericTextSql } from './numeric-text.js';
import {
  FIELD_NAME_RE,
  assertNoClash,
  joinOutputSchema,
  joinedNames,
  keptPropsSql,
  keptSchema,
  validateAliases,
  validateKeepFields,
} from './join-fields.js';

export type AttributeJoinParams = AttributeJoinStep['params'];

const MAX_ATTRS_TO_KEEP = 16;
const DEFAULT_PREFIX = 'joined_';

function isKeyName(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    (v === ATTRIBUTE_JOIN_FEATURE_ID || FIELD_NAME_RE.test(v))
  );
}

/**
 * Attribute-join generator: the table join of a desktop GIS. Each
 * upstream row looks up rows of a second data_layer whose key equals
 * its own, and gains either a match count or the attributes of one
 * match. Either key may be the feature id, which is how a child layer
 * reaches its parent through a global-id foreign key.
 *
 * The right side is grouped by key once and hash-joined, so the cost
 * grows with the two row counts added, not multiplied. A spatial join
 * has no key to group on and probes the right side per left row.
 */
export const attributeJoinGenerator: ToolGenerator<AttributeJoinParams> = {
  kind: 'attribute-join',

  validate(raw: unknown, ctx?: ToolValidateContext): AttributeJoinParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('attribute-join.params must be an object');
    }
    const r = raw as Record<string, unknown>;

    const other = r.otherSource as Record<string, unknown> | undefined;
    if (
      !other ||
      other.kind !== 'data_layer' ||
      typeof other.itemId !== 'string' ||
      other.itemId.length === 0
    ) {
      throw new BadRequestException(
        'attribute-join.params.otherSource must be { kind: "data_layer", itemId: <uuid>, layerKey?: string }',
      );
    }
    const otherSource: AttributeJoinParams['otherSource'] = {
      kind: 'data_layer',
      itemId: other.itemId,
      ...(typeof other.layerKey === 'string' && other.layerKey.length > 0
        ? { layerKey: other.layerKey }
        : {}),
    };

    if (!isKeyName(r.leftField)) {
      throw new BadRequestException(
        'attribute-join.params.leftField must name an input field (or the feature id)',
      );
    }
    if (!isKeyName(r.rightField)) {
      throw new BadRequestException(
        'attribute-join.params.rightField must name a field of the other layer (or the feature id)',
      );
    }
    const leftField = r.leftField;
    const rightField = r.rightField;
    if (
      ctx?.sourceSchema &&
      leftField !== ATTRIBUTE_JOIN_FEATURE_ID &&
      !ctx.sourceSchema.some((f) => f.name === leftField)
    ) {
      throw new BadRequestException(
        `attribute-join.params.leftField "${leftField}" is not a field of the input`,
      );
    }

    const joinType = r.joinType ?? 'left';
    if (joinType !== 'left' && joinType !== 'inner') {
      throw new BadRequestException(
        "attribute-join.params.joinType must be 'left' or 'inner'",
      );
    }

    const attributeStrategy = r.attributeStrategy;
    if (attributeStrategy !== 'count' && attributeStrategy !== 'first') {
      throw new BadRequestException(
        "attribute-join.params.attributeStrategy must be 'count' or 'first'",
      );
    }

    let attrsToKeep: string[] | undefined;
    if (attributeStrategy === 'first') {
      const rawAttrs = r.attrsToKeep;
      if (!Array.isArray(rawAttrs) || rawAttrs.length === 0) {
        throw new BadRequestException(
          'attribute-join.params.attrsToKeep must be a non-empty array when attributeStrategy is "first"',
        );
      }
      if (rawAttrs.length > MAX_ATTRS_TO_KEEP) {
        throw new BadRequestException(
          `attribute-join.params.attrsToKeep supports at most ${MAX_ATTRS_TO_KEEP} attrs`,
        );
      }
      const list: string[] = [];
      for (const a of rawAttrs) {
        if (typeof a !== 'string' || !FIELD_NAME_RE.test(a)) {
          throw new BadRequestException(
            `attribute-join.params.attrsToKeep entries must match ${FIELD_NAME_RE}`,
          );
        }
        if (!list.includes(a)) list.push(a);
      }
      attrsToKeep = list;
    }

    // Only 'first' picks a row, so a count ignores any orderBy.
    let orderBy: AttributeJoinParams['orderBy'];
    if (attributeStrategy === 'first' && r.orderBy != null) {
      const o = r.orderBy as Record<string, unknown>;
      if (typeof o !== 'object' || !isKeyName(o.field)) {
        throw new BadRequestException(
          'attribute-join.params.orderBy.field must name a field of the other layer (or the feature id)',
        );
      }
      const direction = o.direction ?? 'asc';
      if (direction !== 'asc' && direction !== 'desc') {
        throw new BadRequestException(
          "attribute-join.params.orderBy.direction must be 'asc' or 'desc'",
        );
      }
      orderBy = { field: o.field, direction };
    }

    const keepFields = validateKeepFields('attribute-join', r.keepFields, ctx?.sourceSchema);

    const attrPrefixRaw = r.attrPrefix;
    const attrPrefix =
      typeof attrPrefixRaw === 'string' && attrPrefixRaw.length > 0
        ? attrPrefixRaw
        : DEFAULT_PREFIX;
    if (!FIELD_NAME_RE.test(attrPrefix)) {
      throw new BadRequestException(
        'attribute-join.params.attrPrefix must match the field-name shape (letters / digits / underscore, not starting with a digit)',
      );
    }

    const joined = joinedNames(attributeStrategy, attrsToKeep, attrPrefix);
    const kept = ctx?.sourceSchema ? keptSchema(ctx.sourceSchema, keepFields) : null;
    const aliases = validateAliases(
      'attribute-join',
      r.aliases,
      kept ? new Set([...kept.map((f) => f.name), ...joined]) : null,
    );
    if (kept) assertNoClash('attribute-join', kept, joined);

    return {
      otherSource,
      leftField,
      rightField,
      joinType,
      ...(r.ignoreCase === true ? { ignoreCase: true } : {}),
      ...(keepFields !== undefined ? { keepFields } : {}),
      attributeStrategy,
      ...(attrsToKeep !== undefined ? { attrsToKeep } : {}),
      ...(orderBy ? { orderBy } : {}),
      ...(aliases ? { aliases } : {}),
      attrPrefix,
    };
  },

  outputSchema(input: FeatureField[], params: AttributeJoinParams): FeatureField[] {
    return joinOutputSchema(input, params, DEFAULT_PREFIX);
  },

  outwardReachMeters(): number {
    return 0;
  },

  extractDependencies(params: AttributeJoinParams): ToolDependencies {
    return { itemIds: [params.otherSource.itemId], urls: [] };
  },

  toSql(inputAlias: string, params: AttributeJoinParams, paramOffset: number) {
    const sqlParams: unknown[] = [];
    const ph = (v: unknown): string => {
      sqlParams.push(v);
      return `$${paramOffset + sqlParams.length}`;
    };
    const right = params.otherSource;
    const rightCte = dataLayerSourceSqlFragment(
      dataLayerScope(right.itemId, right.layerKey ?? 'default'),
      { collapseConditions: ['valid_to IS NULL'] },
    );

    // Keys compare as trimmed text, so a number stored as 12 matches
    // "12", and an empty key never matches anything.
    const keyExpr = (alias: string, field: string): string => {
      const raw =
        field === ATTRIBUTE_JOIN_FEATURE_ID
          ? `${alias}.global_id::text`
          : `${alias}.properties->>(${ph(field)}::text)`;
      const trimmed = `NULLIF(btrim(${raw}), '')`;
      return params.ignoreCase ? `lower(${trimmed})` : trimmed;
    };
    const rightKey = keyExpr('r', params.rightField);
    const leftKey = keyExpr('l', params.leftField);

    const prefix = params.attrPrefix ?? DEFAULT_PREFIX;
    let grouped: string;
    let joined: string;
    if (params.attributeStrategy === 'count') {
      grouped = `
        SELECT k, COUNT(*) AS n
        FROM (SELECT ${rightKey} AS k FROM right_rows r) rk
        WHERE k IS NOT NULL
        GROUP BY k`;
      joined = `jsonb_build_object(${ph(`${prefix}count`)}::text, COALESCE(m.n, 0))`;
    } else {
      const pairs = (params.attrsToKeep ?? []).map(
        (a) => `${ph(`${prefix}${a}`)}::text, r.properties->>(${ph(a)}::text)`,
      );
      // DISTINCT ON keeps the first row per key. With orderBy that is
      // the lowest (or highest) value: numbers compare as numbers and
      // anything else as text, so ISO dates sort by time; empty values
      // go last. The global id breaks ties, so repeated reads agree.
      let orderCol = '';
      let orderSql = '';
      if (params.orderBy) {
        const o = params.orderBy;
        const raw =
          o.field === ATTRIBUTE_JOIN_FEATURE_ID
            ? 'r.global_id::text'
            : `r.properties->>(${ph(o.field)}::text)`;
        const dir = o.direction === 'desc' ? 'DESC' : 'ASC';
        orderCol = `, NULLIF(btrim(${raw}), '') AS ov`;
        orderSql = `${numericTextSql('ov')} ${dir} NULLS LAST, ov ${dir} NULLS LAST, `;
      }
      grouped = `
        SELECT DISTINCT ON (k) k, attrs
        FROM (
          SELECT ${rightKey} AS k, r.global_id${orderCol},
                 jsonb_build_object(${pairs.join(', ')}) AS attrs
          FROM right_rows r
        ) rk
        WHERE k IS NOT NULL
        ORDER BY k, ${orderSql}global_id`;
      // Unmatched rows still carry the columns, as null.
      const nulls = (params.attrsToKeep ?? []).map(
        (a) => `${ph(`${prefix}${a}`)}::text, NULL::text`,
      );
      joined = `COALESCE(m.attrs, jsonb_build_object(${nulls.join(', ')}))`;
    }

    // The key is read before the input's fields are cut down, so a
    // join on a field that is not kept still works.
    const leftProps = keptPropsSql(params.keepFields, ph);
    const joinKind = params.joinType === 'inner' ? 'JOIN' : 'LEFT JOIN';
    const sql = `
      WITH right_rows AS (${rightCte}),
      matches AS (${grouped})
      SELECT
        l.global_id,
        l.geom,
        ${leftProps} || ${joined} AS properties
      FROM ${inputAlias} l
      ${joinKind} matches m ON m.k = ${leftKey}
    `;
    return { sql, params: sqlParams };
  },
};
