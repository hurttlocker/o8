import { describe, expect, it } from 'vitest';
import { normalizeDeclaredActions, validateActionPayload } from './schema-validate';
import { TASK_ARTIFACT_LIMITS } from './types';

const triage = {
  fields: { note: { type: 'string', maxLength: 200 } },
  rows: {
    fields: {
      issue: { type: 'integer', required: true, min: 1 },
      priority: { type: 'string', required: true, enum: ['p1', 'p2', 'p3', 'park'] },
      note: { type: 'string', maxLength: 120 },
    },
    maxRows: 50,
  },
} as const;

describe('normalizeDeclaredActions', () => {
  it('accepts a well-formed declaration and normalizes it', () => {
    const result = normalizeDeclaredActions([{ name: 'submit', label: '  Send triage  ', schema: triage }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions[0]).toMatchObject({ name: 'submit', label: 'Send triage' });
    expect(result.actions[0].schema.rows?.maxRows).toBe(50);
  });

  it('rejects bad names, duplicates, unknown field types, and an empty list', () => {
    expect(normalizeDeclaredActions([])).toMatchObject({ ok: false });
    expect(normalizeDeclaredActions([{ name: 'Submit!', schema: triage }])).toMatchObject({ ok: false });
    expect(normalizeDeclaredActions([{ name: 'a', schema: triage }, { name: 'a', schema: triage }])).toMatchObject({ ok: false });
    const badType = normalizeDeclaredActions([{ name: 'a', schema: { fields: { x: { type: 'object' } } } }]);
    expect(badType.ok).toBe(false);
    if (!badType.ok) expect(badType.errors.join(' ')).toContain('expected one of');
  });

  it('caps the number of declared actions', () => {
    const many = Array.from({ length: TASK_ARTIFACT_LIMITS.maxDeclaredActions + 1 }, (_, i) => ({ name: `a${i}`, schema: triage }));
    expect(normalizeDeclaredActions(many)).toMatchObject({ ok: false });
  });
});

describe('validateActionPayload', () => {
  const schema = normalizeDeclaredActions([{ name: 'submit', schema: triage }]);
  const declared = schema.ok ? schema.actions[0].schema : null;

  it('accepts the exact declared shape', () => {
    expect(declared).not.toBeNull();
    const verdict = validateActionPayload(declared!, {
      note: 'triage pass',
      rows: [{ issue: 1665, priority: 'p2', note: 'reframe' }, { issue: 1875, priority: 'park' }],
    });
    expect(verdict).toEqual({ ok: true });
  });

  it('refuses undeclared keys, wrong types, enum misses, and missing required fields', () => {
    const verdict = validateActionPayload(declared!, {
      extra: true,
      rows: [{ issue: 'x', priority: 'urgent' }, { priority: 'p1' }],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.errors).toEqual(expect.arrayContaining([
      'payload.extra: not declared',
      'payload.rows[0].issue: expected integer',
      'payload.rows[0].priority: not one of p1, p2, p3, park',
      'payload.rows[1].issue: required',
    ]));
  });

  it('bounds rows and string lengths', () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ issue: i + 1, priority: 'p3' }));
    expect(validateActionPayload(declared!, { rows })).toMatchObject({ ok: false });
    expect(validateActionPayload(declared!, { note: 'x'.repeat(201), rows: [] })).toMatchObject({ ok: false });
  });

  it('refuses rows when the action declared none', () => {
    const flat = normalizeDeclaredActions([{ name: 'rank', schema: { fields: { winner: { type: 'string', required: true } } } }]);
    expect(flat.ok).toBe(true);
    if (!flat.ok) return;
    expect(validateActionPayload(flat.actions[0].schema, { winner: 'a', rows: [] })).toMatchObject({ ok: false });
    expect(validateActionPayload(flat.actions[0].schema, { winner: 'a' })).toEqual({ ok: true });
  });
});
