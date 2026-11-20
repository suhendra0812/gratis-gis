// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import { attributeJoinGenerator } from './attribute-join.js';

const OTHER = { kind: 'data_layer', itemId: 'item-1', layerKey: 'jalur' };
const SCHEMA: FeatureField[] = [
  { name: 'saluran_globalid', label: 'Saluran', type: 'string', nullable: true },
  { name: 'status', label: 'Status', type: 'string', nullable: true },
];

function valid(extra: Record<string, unknown> = {}) {
  return {
    otherSource: OTHER,
    leftField: 'saluran_globalid',
    rightField: '$id',
    attributeStrategy: 'first',
    attrsToKeep: ['nama_lokasi', 'panjang'],
    ...extra,
  };
}

describe('attributeJoinGenerator.validate', () => {
  it('fills the defaults', () => {
    const out = attributeJoinGenerator.validate(valid(), { sourceSchema: SCHEMA });
    expect(out).toEqual({
      otherSource: OTHER,
      leftField: 'saluran_globalid',
      rightField: '$id',
      joinType: 'left',
      attributeStrategy: 'first',
      attrsToKeep: ['nama_lokasi', 'panjang'],
      attrPrefix: 'joined_',
    });
  });

  it('keeps inner join and ignoreCase', () => {
    const out = attributeJoinGenerator.validate(
      valid({ joinType: 'inner', ignoreCase: true }),
    );
    expect(out.joinType).toBe('inner');
    expect(out.ignoreCase).toBe(true);
  });

  it.each([
    [{ otherSource: { kind: 'data_layer', itemId: '' } }, /otherSource/],
    [{ leftField: '' }, /leftField/],
    [{ leftField: 'a b' }, /leftField/],
    [{ rightField: "x'; drop" }, /rightField/],
    [{ joinType: 'full' }, /joinType/],
    [{ attributeStrategy: 'all' }, /attributeStrategy/],
    [{ attrsToKeep: [] }, /attrsToKeep/],
    [{ attrsToKeep: ['ok', 'not ok'] }, /attrsToKeep/],
    [{ attrPrefix: '1x' }, /attrPrefix/],
  ])('rejects %o', (patch, msg) => {
    expect(() => attributeJoinGenerator.validate(valid(patch))).toThrow(msg);
  });

  it('rejects a left field the input does not have', () => {
    expect(() =>
      attributeJoinGenerator.validate(valid({ leftField: 'nope' }), {
        sourceSchema: SCHEMA,
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects an output name that is already an input field', () => {
    expect(() =>
      attributeJoinGenerator.validate(
        valid({ attrPrefix: 'x_', attrsToKeep: ['status'] }),
        { sourceSchema: [...SCHEMA, { name: 'x_status', label: 'x', type: 'string', nullable: true }] },
      ),
    ).toThrow(/x_status/);
  });

  it('keeps orderBy for first and drops it for count', () => {
    const first = attributeJoinGenerator.validate(
      valid({ orderBy: { field: 'tanggal' } }),
    );
    expect(first.orderBy).toEqual({ field: 'tanggal', direction: 'asc' });
    const count = attributeJoinGenerator.validate(
      valid({ attributeStrategy: 'count', orderBy: { field: 'tanggal', direction: 'desc' } }),
    );
    expect(count.orderBy).toBeUndefined();
  });

  it.each([
    [{ field: 'a b' }, /orderBy.field/],
    [{ field: 'tanggal', direction: 'down' }, /orderBy.direction/],
  ])('rejects orderBy %o', (orderBy, msg) => {
    expect(() => attributeJoinGenerator.validate(valid({ orderBy }))).toThrow(msg);
  });

  it('keeps a subset of input fields and checks them against the input', () => {
    const out = attributeJoinGenerator.validate(
      valid({ keepFields: ['status', 'status'] }),
      { sourceSchema: SCHEMA },
    );
    expect(out.keepFields).toEqual(['status']);
    expect(() =>
      attributeJoinGenerator.validate(valid({ keepFields: ['nope'] }), { sourceSchema: SCHEMA }),
    ).toThrow(/keepFields/);
    expect(() => attributeJoinGenerator.validate(valid({ keepFields: 'status' }))).toThrow(
      /keepFields/,
    );
  });

  it('lets a joined field reuse the name of an input field that is dropped', () => {
    const out = attributeJoinGenerator.validate(
      valid({ attrPrefix: 'x_', attrsToKeep: ['status'], keepFields: ['saluran_globalid'] }),
      { sourceSchema: [...SCHEMA, { name: 'x_status', label: 'x', type: 'string', nullable: true }] },
    );
    expect(out.keepFields).toEqual(['saluran_globalid']);
  });

  it('keeps aliases for output fields and drops the rest', () => {
    const out = attributeJoinGenerator.validate(
      valid({
        keepFields: ['status'],
        aliases: {
          status: '  Status kegiatan ',
          joined_panjang: 'Panjang saluran',
          saluran_globalid: 'Not output any more',
          joined_nama_lokasi: '   ',
        },
      }),
      { sourceSchema: SCHEMA },
    );
    expect(out.aliases).toEqual({
      status: 'Status kegiatan',
      joined_panjang: 'Panjang saluran',
    });
  });

  it.each([
    [['x'], /aliases must be an object/],
    [{ 'bad name': 'x' }, /aliases must map/],
    [{ status: 3 }, /aliases must map/],
    [{ status: 'x'.repeat(121) }, /longer than 120/],
  ])('rejects aliases %o', (aliases, msg) => {
    expect(() => attributeJoinGenerator.validate(valid({ aliases }))).toThrow(msg);
  });

  it('drops duplicate attrs', () => {
    const out = attributeJoinGenerator.validate(
      valid({ attrsToKeep: ['panjang', 'panjang'] }),
    );
    expect(out.attrsToKeep).toEqual(['panjang']);
  });
});

describe('attributeJoinGenerator.outputSchema', () => {
  it('adds a count column', () => {
    const p = attributeJoinGenerator.validate(
      valid({ attributeStrategy: 'count', attrPrefix: 'kegiatan_' }),
    );
    expect(attributeJoinGenerator.outputSchema(SCHEMA, p).map((f) => f.name)).toEqual([
      'saluran_globalid',
      'status',
      'kegiatan_count',
    ]);
  });

  it('leaves out input fields that are not kept', () => {
    const p = attributeJoinGenerator.validate(valid({ keepFields: ['status'] }));
    expect(attributeJoinGenerator.outputSchema(SCHEMA, p).map((f) => f.name)).toEqual([
      'status',
      'joined_nama_lokasi',
      'joined_panjang',
    ]);
  });

  it('applies aliases as labels without renaming fields', () => {
    const p = attributeJoinGenerator.validate(
      valid({ aliases: { status: 'Status kegiatan', joined_panjang: 'Panjang saluran' } }),
    );
    const out = attributeJoinGenerator.outputSchema(SCHEMA, p);
    expect(out.map((f) => [f.name, f.label])).toEqual([
      ['saluran_globalid', 'Saluran'],
      ['status', 'Status kegiatan'],
      ['joined_nama_lokasi', 'joined_nama_lokasi'],
      ['joined_panjang', 'Panjang saluran'],
    ]);
  });

  it('adds one column per kept attribute', () => {
    const p = attributeJoinGenerator.validate(valid());
    const out = attributeJoinGenerator.outputSchema(SCHEMA, p);
    expect(out.slice(2)).toEqual([
      { name: 'joined_nama_lokasi', label: 'joined_nama_lokasi', type: 'string', nullable: true },
      { name: 'joined_panjang', label: 'joined_panjang', type: 'string', nullable: true },
    ]);
  });
});

describe('attributeJoinGenerator.toSql', () => {
  it('passes field names as parameters, never in the SQL text', () => {
    const p = attributeJoinGenerator.validate(valid());
    const { sql, params } = attributeJoinGenerator.toSql('step_0', p, 3);
    expect(sql).not.toContain('saluran_globalid');
    expect(sql).not.toContain('nama_lokasi');
    expect(sql).toContain('r.global_id::text');
    expect(sql).toContain('LEFT JOIN matches m');
    expect(sql).toContain('$4');
    expect(params).toContain('saluran_globalid');
    expect(params).toContain('joined_panjang');
  });

  it('orders the matches by the chosen field, then by id', () => {
    const p = attributeJoinGenerator.validate(
      valid({ orderBy: { field: 'tanggal', direction: 'desc' } }),
    );
    const { sql, params } = attributeJoinGenerator.toSql('step_0', p, 0);
    expect(sql).toMatch(/ORDER BY k, \(CASE WHEN ov ~ .* DESC NULLS LAST, ov DESC NULLS LAST, global_id/);
    expect(params).toContain('tanggal');
  });

  it('uses an inner join and lowercases keys when asked', () => {
    const p = attributeJoinGenerator.validate(
      valid({ joinType: 'inner', ignoreCase: true }),
    );
    const { sql } = attributeJoinGenerator.toSql('step_0', p, 0);
    expect(sql).not.toContain('LEFT JOIN');
    expect(sql).toMatch(/JOIN matches m ON m\.k = lower\(/);
  });

  it('reports the other layer as a dependency', () => {
    const p = attributeJoinGenerator.validate(valid());
    expect(attributeJoinGenerator.extractDependencies(p).itemIds).toEqual(['item-1']);
  });
});
