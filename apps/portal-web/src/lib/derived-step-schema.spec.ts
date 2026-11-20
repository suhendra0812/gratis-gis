// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FeatureField, ToolStep } from '@gratis-gis/shared-types';
import { stepInputSchemas } from './derived-step-schema';

const source: FeatureField[] = [
  { name: 'elev', label: 'Elevation', type: 'number', nullable: true },
  { name: 'name', label: 'Name', type: 'string', nullable: true },
];

const names = (fields: FeatureField[]) => fields.map((f) => f.name);

describe('stepInputSchemas', () => {
  it('lets later steps see fields earlier steps add', () => {
    const pipeline = [
      {
        tool: 'calculate-geometry',
        params: { measure: 'area', fieldName: 'area', unit: 'square-meters' },
      },
      {
        tool: 'calculate-field',
        params: { outputName: 'ratio', outputType: 'number', expression: '{{elev}} / {{area}}' },
      },
      { tool: 'top-n', params: { field: 'ratio', n: 10, direction: 'desc' } },
      { tool: 'filter', params: { expression: '{{ratio}} > 1' } },
    ] as unknown as ToolStep[];
    const schemas = stepInputSchemas(source, pipeline);
    expect(schemas.map(names)).toEqual([
      ['elev', 'name'],
      ['elev', 'name', 'area'],
      ['elev', 'name', 'area', 'ratio'],
      ['elev', 'name', 'area', 'ratio'],
    ]);
  });

  it('replaces the schema after an aggregate and empties it after a dissolve', () => {
    const pipeline = [
      {
        tool: 'aggregate',
        params: {
          groupBy: ['name'],
          aggs: [{ field: 'elev', op: 'avg', outputName: 'mean_elev' }],
        },
      },
      { tool: 'dissolve', params: {} },
      { tool: 'centroid', params: {} },
    ] as unknown as ToolStep[];
    const schemas = stepInputSchemas(source, pipeline);
    expect(names(schemas[1]!)).toEqual(['name', 'mean_elev']);
    expect(schemas[1]![1]!.type).toBe('number');
    expect(schemas[2]).toEqual([]);
  });

  it('adds a count column for an attribute join', () => {
    const pipeline = [
      {
        tool: 'attribute-join',
        params: {
          otherSource: { kind: 'data_layer', itemId: 'x' },
          leftField: '$id',
          rightField: 'parent_id',
          joinType: 'left',
          attributeStrategy: 'count',
          attrPrefix: 'kids_',
        },
      },
      { tool: 'filter', params: { expression: '{{kids_count}} > 0' } },
    ] as unknown as ToolStep[];
    const schemas = stepInputSchemas(source, pipeline);
    expect(names(schemas[1]!)).toEqual(['elev', 'name', 'kids_count']);

    const trimmed = stepInputSchemas(source, [
      { ...pipeline[0], params: { ...pipeline[0]!.params, keepFields: ['name'] } } as ToolStep,
      pipeline[1]!,
    ]);
    expect(names(trimmed[1]!)).toEqual(['name', 'kids_count']);

    const aliased = stepInputSchemas(source, [
      { ...pipeline[0], params: { ...pipeline[0]!.params, aliases: { kids_count: 'Kids' } } } as ToolStep,
      pipeline[1]!,
    ]);
    expect(aliased[1]!.map((f) => f.label)).toEqual(['Elevation', 'Name', 'Kids']);
    expect(schemas[1]![2]!.type).toBe('number');
  });

  it('adds prefixed columns for a spatial join', () => {
    const pipeline = [
      {
        tool: 'spatial-join',
        params: {
          otherSource: { kind: 'data_layer', itemId: 'x' },
          predicate: 'intersects',
          attributeStrategy: 'first',
          attrsToKeep: ['fips'],
        },
      },
      { tool: 'centroid', params: {} },
    ] as unknown as ToolStep[];
    expect(names(stepInputSchemas(source, pipeline)[1]!)).toEqual([
      'elev',
      'name',
      'joined_fips',
    ]);
    const trimmed = stepInputSchemas(source, [
      {
        ...pipeline[0],
        params: { ...pipeline[0]!.params, keepFields: ['name'], aliases: { joined_fips: 'FIPS' } },
      } as ToolStep,
      pipeline[1]!,
    ])[1]!;
    expect(trimmed.map((f) => [f.name, f.label])).toEqual([
      ['name', 'Name'],
      ['joined_fips', 'FIPS'],
    ]);
  });
});
