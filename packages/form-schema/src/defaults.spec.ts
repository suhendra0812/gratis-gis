// SPDX-License-Identifier: AGPL-3.0-or-later
import { applyDefaults, type FormSchema, type Question, type Response } from './index.js';

function form(questions: Question[]): FormSchema {
  return { schemaVersion: 1, id: 'f', title: 'T', questions } as unknown as FormSchema;
}
const q = (over: Partial<Question>): Question =>
  ({ id: 'q1', type: 'text', label: 'Q', ...over }) as Question;

// 5 Nov 2026, 14:07 local time.
const AT = new Date(2026, 10, 5, 14, 7, 33);

describe('applyDefaults', () => {
  it('fills now in each temporal input format, in local time', () => {
    const r = applyDefaults(
      form([
        q({ id: 'dt', type: 'datetime', defaultValue: 'now' } as Partial<Question>),
        q({ id: 'd', type: 'date', defaultValue: 'today' } as Partial<Question>),
        q({ id: 't', type: 'time', defaultValue: 'now' } as Partial<Question>),
      ]),
      {} as Response,
      AT,
    );
    expect(r).toEqual({ dt: '2026-11-05T14:07', d: '2026-11-05', t: '14:07' });
  });

  it('uses a literal default as is', () => {
    const r = applyDefaults(
      form([q({ id: 'd', type: 'date', defaultValue: '2026-01-31' } as Partial<Question>)]),
      {} as Response,
      AT,
    );
    expect(r).toEqual({ d: '2026-01-31' });
  });

  it('keeps an existing answer, and a cleared one', () => {
    const f = form([q({ id: 'dt', type: 'datetime', defaultValue: 'now' } as Partial<Question>)]);
    expect(applyDefaults(f, { dt: '2020-01-01T00:00' } as Response, AT)).toEqual({ dt: '2020-01-01T00:00' });
    expect(applyDefaults(f, { dt: null } as unknown as Response, AT)).toEqual({ dt: null });
  });

  it('returns the same object when there is nothing to fill', () => {
    const r = {} as Response;
    expect(applyDefaults(form([q({ id: 'a' })]), r, AT)).toBe(r);
  });

  it('fills inside a plain group but not inside a repeat group', () => {
    const r = applyDefaults(
      form([
        q({
          id: 'g',
          type: 'group',
          children: [q({ id: 'in', type: 'date', defaultValue: 'today' } as Partial<Question>)],
        } as Partial<Question>),
        q({
          id: 'rg',
          type: 'group',
          repeat: {},
          children: [q({ id: 'rin', type: 'date', defaultValue: 'today' } as Partial<Question>)],
        } as Partial<Question>),
      ]),
      {} as Response,
      AT,
    );
    expect(r).toEqual({ in: '2026-11-05' });
  });
});
