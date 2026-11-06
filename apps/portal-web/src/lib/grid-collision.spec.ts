// SPDX-License-Identifier: AGPL-3.0-or-later
import { alignmentGuides, boxesOverlap, pushDownCollisions, type GridBox } from './grid-collision';

const box = (id: string, col: number, row: number, colSpan: number, rowSpan: number): GridBox => ({
  id,
  col,
  row,
  colSpan,
  rowSpan,
});
const none = () => false;

describe('boxesOverlap', () => {
  it('treats touching edges as not overlapping', () => {
    expect(boxesOverlap(box('a', 1, 1, 10, 10), box('b', 11, 1, 5, 5))).toBe(false);
    expect(boxesOverlap(box('a', 1, 1, 10, 10), box('b', 1, 11, 5, 5))).toBe(false);
    expect(boxesOverlap(box('a', 1, 1, 10, 10), box('b', 10, 10, 5, 5))).toBe(true);
  });
});

describe('pushDownCollisions', () => {
  it('pushes an overlapped box to just below the moved one', () => {
    const out = pushDownCollisions(
      [box('moved', 1, 1, 20, 10), box('b', 5, 5, 10, 10)],
      'moved',
      none,
    );
    expect(out).toEqual(new Map([['b', 11]]));
  });

  it('cascades through boxes the pushed one lands on', () => {
    const out = pushDownCollisions(
      [box('moved', 1, 1, 20, 10), box('b', 1, 8, 20, 6), box('c', 1, 14, 20, 4)],
      'moved',
      none,
    );
    expect(out.get('b')).toBe(11);
    expect(out.get('c')).toBe(17);
  });

  it('leaves boxes alone that do not overlap', () => {
    const out = pushDownCollisions(
      [box('moved', 1, 1, 10, 10), box('side', 11, 1, 10, 10), box('below', 1, 20, 10, 5)],
      'moved',
      none,
    );
    expect(out.size).toBe(0);
  });

  it('lets widgets float over a background map', () => {
    const bg = (id: string) => id === 'map';
    // A button dropped on a map: nothing moves.
    expect(
      pushDownCollisions([box('map', 1, 1, 100, 50), box('btn', 5, 5, 4, 4)], 'btn', bg).size,
    ).toBe(0);
    // The map moved over a panel: nothing moves either.
    expect(
      pushDownCollisions([box('map', 1, 1, 100, 50), box('panel', 1, 10, 20, 10)], 'map', bg)
        .size,
    ).toBe(0);
  });

  it('never moves the dropped box itself', () => {
    const out = pushDownCollisions(
      [box('moved', 1, 5, 10, 10), box('above', 1, 1, 10, 8)],
      'moved',
      none,
    );
    expect(out.has('moved')).toBe(false);
    expect(out.get('above')).toBe(15);
  });
});

describe('alignmentGuides', () => {
  it('reports shared left and top edges', () => {
    const g = alignmentGuides(box('m', 10, 20, 7, 3), [box('o', 10, 20, 9, 5)]);
    expect(g).toEqual(
      expect.arrayContaining([
        { axis: 'x', line: 10, center: false },
        { axis: 'y', line: 20, center: false },
      ]),
    );
  });

  it('reports a right edge meeting another box’s left edge', () => {
    const g = alignmentGuides(box('m', 1, 1, 10, 3), [box('o', 11, 30, 5, 5)]);
    expect(g).toContainEqual({ axis: 'x', line: 11, center: false });
  });

  it('reports centred boxes', () => {
    const g = alignmentGuides(box('m', 21, 1, 20, 3), [box('o', 11, 40, 40, 5)]);
    expect(g).toContainEqual({ axis: 'x', line: 31, center: true });
  });

  it('ignores itself and reports nothing when nothing lines up', () => {
    expect(alignmentGuides(box('m', 3, 3, 5, 5), [box('m', 3, 3, 5, 5), box('o', 50, 50, 3, 3)])).toEqual(
      [],
    );
  });
});
