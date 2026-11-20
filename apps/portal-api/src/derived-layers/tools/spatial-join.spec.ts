// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FeatureField } from '@gratis-gis/shared-types';

import { spatialJoinGenerator } from './spatial-join.js';

const OTHER = { kind: 'data_layer', itemId: 'item-1', layerKey: 'jalur' };
const SCHEMA: FeatureField[] = [
  { name: 'kode', label: 'Kode', type: 'string', nullable: true },
  { name: 'status', label: 'Status', type: 'string', nullable: true },
];

function valid(extra: Record<string, unknown> = {}) {
  return {
    otherSource: OTHER,
    predicate: 'intersects',
    attributeStrategy: 'first',
    attrsToKeep: ['nama_lokasi', 'panjang'],
    ...extra,
  };
}

describe('spatialJoinGenerator field options', () => {
  it('leaves keepFields and aliases out when unset', () => {
    const out = spatialJoinGenerator.validate(valid(), { sourceSchema: SCHEMA });
    expect(out).toEqual({
      otherSource: OTHER,
      predicate: 'intersects',
      attributeStrategy: 'first',
      attrsToKeep: ['nama_lokasi', 'panjang'],
      attrPrefix: 'joined_',
    });
  });

  it('checks keepFields against the input', () => {
    const out = spatialJoinGenerator.validate(
      valid({ keepFields: ['status', 'status'] }),
      { sourceSchema: SCHEMA },
    );
    expect(out.keepFields).toEqual(['status']);
    expect(() =>
      spatialJoinGenerator.validate(valid({ keepFields: ['nope'] }), { sourceSchema: SCHEMA }),
    ).toThrow(/keepFields/);
  });

  it('lets a joined field reuse the name of an input field that is dropped', () => {
    const schema = [...SCHEMA, { name: 'x_status', label: 'x', type: 'string' as const, nullable: true }];
    expect(() =>
      spatialJoinGenerator.validate(valid({ attrPrefix: 'x_', attrsToKeep: ['status'] }), {
        sourceSchema: schema,
      }),
    ).toThrow(/x_status/);
    const out = spatialJoinGenerator.validate(
      valid({ attrPrefix: 'x_', attrsToKeep: ['status'], keepFields: ['kode'] }),
      { sourceSchema: schema },
    );
    expect(out.keepFields).toEqual(['kode']);
  });

  it('keeps aliases for output fields and drops the rest', () => {
    const out = spatialJoinGenerator.validate(
      valid({
        attributeStrategy: 'count',
        keepFields: ['status'],
        aliases: { status: ' Status ', joined_count: 'Jumlah', kode: 'gone', joined_panjang: 'gone' },
      }),
      { sourceSchema: SCHEMA },
    );
    expect(out.aliases).toEqual({ status: 'Status', joined_count: 'Jumlah' });
  });

  it.each([
    [['x'], /aliases must be an object/],
    [{ status: 3 }, /aliases must map/],
    [{ status: 'x'.repeat(121) }, /longer than 120/],
  ])('rejects aliases %o', (aliases, msg) => {
    expect(() => spatialJoinGenerator.validate(valid({ aliases }))).toThrow(msg);
  });

  it('builds the output schema from the kept fields with aliases as labels', () => {
    const p = spatialJoinGenerator.validate(
      valid({ keepFields: ['status'], aliases: { joined_panjang: 'Panjang' } }),
    );
    expect(spatialJoinGenerator.outputSchema(SCHEMA, p).map((f) => [f.name, f.label])).toEqual([
      ['status', 'Status'],
      ['joined_nama_lokasi', 'joined_nama_lokasi'],
      ['joined_panjang', 'Panjang'],
    ]);
  });

  it('passes kept field names as a parameter', () => {
    const all = spatialJoinGenerator.toSql('step_0', spatialJoinGenerator.validate(valid()), 0);
    expect(all.sql).toContain('l.properties ||');
    const p = spatialJoinGenerator.validate(valid({ keepFields: ['status'] }));
    const { sql, params } = spatialJoinGenerator.toSql('step_0', p, 2);
    expect(sql).toContain('jsonb_each(l.properties)');
    expect(sql).not.toContain("'status'");
    expect(params).toContainEqual(['status']);
    expect(sql).toContain(`$${2 + params.length}::text[]`);
  });
});
