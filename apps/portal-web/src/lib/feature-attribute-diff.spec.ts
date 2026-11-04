// SPDX-License-Identifier: AGPL-3.0-or-later
import { changedValues } from './feature-attribute-diff';

describe('changedValues', () => {
  it('returns only the fields that changed', () => {
    expect(
      changedValues({ name: 'A', floors: 3 }, { name: 'A', floors: 4 }),
    ).toEqual({ floors: 4 });
  });

  it('returns nothing when the form is saved untouched', () => {
    expect(changedValues({ name: 'A', tags: ['x'] }, { name: 'A', tags: ['x'] })).toEqual({});
  });

  it('treats an empty input over a missing value as no change', () => {
    expect(changedValues({}, { note: '' })).toEqual({});
    expect(changedValues({ note: null }, { note: '' })).toEqual({});
  });

  it('keeps a value cleared on purpose', () => {
    expect(changedValues({ note: 'old' }, { note: null })).toEqual({ note: null });
  });

  it('never sends server-maintained columns', () => {
    expect(
      changedValues(
        { _global_id: 'g1', submitted_at: 't1', name: 'A' },
        { _global_id: 'g2', submitted_at: 't2', name: 'A' },
      ),
    ).toEqual({});
  });
});
