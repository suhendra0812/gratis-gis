// SPDX-License-Identifier: AGPL-3.0-or-later
import { relatedTableRefs, type DataLayerSublayer } from './data-layer';

const layer = (over: Partial<DataLayerSublayer>): DataLayerSublayer => ({
  id: 'x',
  label: 'X',
  name: 'x',
  geometryType: null,
  fields: [],
  editingEnabled: true,
  attachmentsEnabled: false,
  ...over,
});

describe('relatedTableRefs', () => {
  const poles = layer({ id: 'poles', label: 'Poles', geometryType: 'point' });
  const trees = layer({ id: 'trees', label: 'Trees', geometryType: 'point' });
  const poleInspections = layer({
    id: 'pole_insp',
    label: 'Pole inspections',
    parentLayerId: 'poles',
    parentFkColumn: 'pole_id',
  });

  it('lists an in-item child under its own parent only', () => {
    const layers = [poles, trees, poleInspections];
    expect(relatedTableRefs('item', layers, 'poles')).toEqual([
      { itemId: 'item', layerId: 'pole_insp', fkColumn: 'pole_id', label: 'Pole inspections' },
    ]);
    // The field app bug: this used to come back for trees too.
    expect(relatedTableRefs('item', layers, 'trees')).toEqual([]);
  });

  it('attributes a legacy child without parentLayerId only when unambiguous', () => {
    const legacy = layer({ id: 'visits', label: 'Visits', parentFkColumn: 'parent_id' });
    expect(relatedTableRefs('item', [poles, legacy], 'poles')).toHaveLength(1);
    expect(relatedTableRefs('item', [poles, trees, legacy], 'poles')).toEqual([]);
  });

  it('adds relationships declared on the parent, including other items', () => {
    const withRel = layer({
      ...poles,
      relationships: [
        {
          id: 'r1',
          label: 'Work orders',
          childItemId: 'other',
          childLayerId: 'orders',
          fkColumn: 'asset_id',
        },
      ],
    });
    expect(relatedTableRefs('item', [withRel, poleInspections], 'poles')).toEqual([
      { itemId: 'item', layerId: 'pole_insp', fkColumn: 'pole_id', label: 'Pole inspections' },
      { itemId: 'other', layerId: 'orders', fkColumn: 'asset_id', label: 'Work orders' },
    ]);
  });

  it('does not list a table twice when declared both ways', () => {
    const withRel = layer({
      ...poles,
      relationships: [
        {
          id: 'r1',
          label: 'Dup',
          childItemId: 'item',
          childLayerId: 'pole_insp',
          fkColumn: 'pole_id',
        },
      ],
    });
    expect(relatedTableRefs('item', [withRel, poleInspections], 'poles')).toHaveLength(1);
  });

  it('ignores a relationship pointing back at the parent itself', () => {
    const self = layer({
      ...poles,
      relationships: [
        { id: 'r', label: 'Self', childItemId: 'item', childLayerId: 'poles', fkColumn: 'p' },
      ],
    });
    expect(relatedTableRefs('item', [self], 'poles')).toEqual([]);
  });
});
