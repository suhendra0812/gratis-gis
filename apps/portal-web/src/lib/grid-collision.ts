// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Layout helpers for the App Builder's page grid: what happens to the
 * other widgets when one is dropped or resized onto them, and which
 * edges line up while it is being dragged.
 *
 * Both work in grid units (1-based col / row plus spans), the same
 * units `CustomLayout` stores, so they are pure and testable.
 *
 * "Background" boxes take no part in collisions. A map (and a tabs
 * widget, which the runtime also paints underneath) is meant to have
 * tool buttons and panels floating over it: pushing a button off the
 * map because it overlaps would break the commonest app layout there
 * is. Background boxes neither push nor get pushed, and a background
 * box being moved pushes nothing.
 */

export interface GridBox {
  id: string;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

export function boxesOverlap(a: GridBox, b: GridBox): boolean {
  return (
    a.col < b.col + b.colSpan &&
    b.col < a.col + a.colSpan &&
    a.row < b.row + b.rowSpan &&
    b.row < a.row + a.rowSpan
  );
}

/**
 * Push every box the moved one now overlaps down to just below it,
 * and so on for whatever those land on, like the Experience Builder
 * and react-grid-layout "push" behaviour. Boxes only ever move down,
 * so the cascade always ends.
 *
 * Returns the new `row` of each box that moved; the moved box itself
 * is never in the result.
 */
export function pushDownCollisions(
  boxes: readonly GridBox[],
  movedId: string,
  isBackground: (id: string) => boolean,
): Map<string, number> {
  const changed = new Map<string, number>();
  if (isBackground(movedId)) return changed;
  const work = new Map(boxes.map((b) => [b.id, { ...b }]));
  const moved = work.get(movedId);
  if (!moved) return changed;

  const queue: GridBox[] = [moved];
  // A generous cap instead of trusting the proof alone: a bug here
  // would hang the designer on mouseup.
  let guard = boxes.length * boxes.length + 10;
  while (queue.length > 0 && guard-- > 0) {
    const cur = queue.shift()!;
    // Top-to-bottom so a box pushed first is the one others stack on.
    const hit = [...work.values()]
      .filter(
        (b) =>
          b.id !== cur.id &&
          b.id !== movedId &&
          !isBackground(b.id) &&
          boxesOverlap(cur, b),
      )
      .sort((a, b) => a.row - b.row || a.col - b.col);
    for (const b of hit) {
      const below = cur.row + cur.rowSpan;
      if (b.row >= below) continue;
      b.row = below;
      changed.set(b.id, below);
      queue.push(b);
    }
  }
  return changed;
}

/** A guide line, in grid lines (1-based, between tracks). */
export interface AlignmentGuide {
  axis: 'x' | 'y';
  /** Grid line: 1 is before the first track, `n + 1` after the last. */
  line: number;
  /** Centre alignment rather than an edge. */
  center: boolean;
}

/**
 * Edges and centres of `moving` that line up with those of any other
 * box, for drawing guides while a widget is dragged or resized. Each
 * line is reported once. Centres are compared only when both centres
 * fall on a grid line (an even span), which is when they can match
 * exactly.
 */
export function alignmentGuides(
  moving: GridBox,
  others: readonly GridBox[],
): AlignmentGuide[] {
  const out: AlignmentGuide[] = [];
  const seen = new Set<string>();
  const add = (axis: 'x' | 'y', line: number, center: boolean) => {
    const key = `${axis}:${line}:${center}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ axis, line, center });
  };
  const edgesX = (b: GridBox) => [b.col, b.col + b.colSpan];
  const edgesY = (b: GridBox) => [b.row, b.row + b.rowSpan];
  const centerX = (b: GridBox) => (b.colSpan % 2 === 0 ? b.col + b.colSpan / 2 : null);
  const centerY = (b: GridBox) => (b.rowSpan % 2 === 0 ? b.row + b.rowSpan / 2 : null);

  for (const o of others) {
    if (o.id === moving.id) continue;
    for (const e of edgesX(moving)) if (edgesX(o).includes(e)) add('x', e, false);
    for (const e of edgesY(moving)) if (edgesY(o).includes(e)) add('y', e, false);
    const mx = centerX(moving);
    if (mx !== null && mx === centerX(o)) add('x', mx, true);
    const my = centerY(moving);
    if (my !== null && my === centerY(o)) add('y', my, true);
  }
  return out;
}
