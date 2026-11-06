// SPDX-License-Identifier: AGPL-3.0-or-later
import { t } from './index';

describe('plural interpolation', () => {
  const key = 'postgisConnectionBuilder.tablesHeading';

  it('uses an exact =0 case and fills placeholders inside it', () => {
    expect(t(key, { count: 0, schema: 'public' })).toBe('No geometry tables in public');
  });

  it('uses one / other with # and a nested placeholder', () => {
    expect(t(key, { count: 1, schema: 'public' })).toBe('1 geometry table in public');
    expect(t(key, { count: 3, schema: 'gis' })).toBe('3 geometry tables in gis');
  });

  it('still handles a flat plural', () => {
    expect(t('postgisConnectionBuilder.rowEstimate', { count: 1 })).toBe('~1 row');
    expect(t('postgisConnectionBuilder.rowEstimate', { count: 40 })).toBe('~40 rows');
  });
});
