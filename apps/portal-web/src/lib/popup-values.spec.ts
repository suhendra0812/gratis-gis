// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  isImageAttachment,
  isStructuredValue,
  parsePopupAttachments,
  popupDisplayValue,
} from './popup-values';

describe('popupDisplayValue', () => {
  it('prints text, numbers and booleans', () => {
    expect(popupDisplayValue('Budi')).toBe('Budi');
    expect(popupDisplayValue(0)).toBe('0');
    expect(popupDisplayValue(false)).toBe('false');
  });

  it('skips empty values', () => {
    expect(popupDisplayValue(null)).toBeNull();
    expect(popupDisplayValue(undefined)).toBeNull();
    expect(popupDisplayValue('')).toBeNull();
    expect(popupDisplayValue([])).toBeNull();
  });

  it('joins a select-multiple answer', () => {
    expect(popupDisplayValue(['a', 'b', 3])).toBe('a, b, 3');
  });

  it('skips a geopoint and attachment descriptors', () => {
    expect(popupDisplayValue({ lat: -6.2, lng: 107.1, accuracy: 5 })).toBeNull();
    expect(
      popupDisplayValue([{ url: '/api/portal/storage/private/x', name: 'signature.png' }]),
    ).toBeNull();
  });
});

describe('isStructuredValue', () => {
  it('flags objects and arrays of objects only', () => {
    expect(isStructuredValue({ lat: 1, lng: 2 })).toBe(true);
    expect(isStructuredValue([{ url: 'u' }])).toBe(true);
    expect(isStructuredValue(['a', 'b'])).toBe(false);
    expect(isStructuredValue('x')).toBe(false);
    expect(isStructuredValue(null)).toBe(false);
  });
});

describe('parsePopupAttachments', () => {
  it('keeps storage-backed rows and fills defaults', () => {
    const rows = parsePopupAttachments([
      {
        id: 'a1',
        fileName: 'tree.png',
        mime: 'image/png',
        sizeBytes: 155,
        storageUrl: '/api/portal/storage/private/feature-attachment/k1',
      },
      { id: 'a2', fileName: 'notes', storageUrl: '/api/portal/storage/private/k2' },
    ]);
    expect(rows).toEqual([
      {
        id: 'a1',
        fileName: 'tree.png',
        mime: 'image/png',
        sizeBytes: 155,
        url: '/api/portal/storage/private/feature-attachment/k1',
      },
      {
        id: 'a2',
        fileName: 'notes',
        mime: 'application/octet-stream',
        sizeBytes: 0,
        url: '/api/portal/storage/private/k2',
      },
    ]);
  });

  it('drops foreign URLs, nameless rows and non-arrays', () => {
    expect(
      parsePopupAttachments([
        { fileName: 'x.png', storageUrl: 'https://evil.example/x.png' },
        { fileName: 'y.png', storageUrl: 'javascript:alert(1)' },
        { storageUrl: '/api/portal/storage/private/k3' },
        null,
      ]),
    ).toEqual([]);
    expect(parsePopupAttachments({ items: [] })).toEqual([]);
  });
});

describe('isImageAttachment', () => {
  it('accepts common raster types and rejects svg and pdf', () => {
    expect(isImageAttachment('image/png')).toBe(true);
    expect(isImageAttachment('image/JPEG')).toBe(true);
    expect(isImageAttachment('image/svg+xml')).toBe(false);
    expect(isImageAttachment('application/pdf')).toBe(false);
  });
});
