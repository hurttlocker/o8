import type { ConflictFact, ConflictPair } from './types';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readConflictString(record: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return fallback;
}

function readConflictNumber(record: Record<string, unknown>, keys: string[], fallback = 0): number {
  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN;

    if (Number.isFinite(parsed)) return parsed;
  }

  return fallback;
}

function normalizeNestedConflictFact(value: unknown): ConflictFact | null {
  const record = asRecord(value);
  if (!record) return null;

  const id = readConflictNumber(record, ['ID', 'id']);
  const subject = readConflictString(record, ['Subject', 'subject']);
  const predicate = readConflictString(record, ['Predicate', 'predicate']);
  const object = readConflictString(record, ['Object', 'object']);

  if (!id || !subject || !predicate || !object) return null;

  return {
    id,
    subject,
    predicate,
    object,
    confidence: readConflictNumber(record, ['Confidence', 'confidence'], 0),
    source: readConflictString(record, ['Source', 'source', 'SourceQuote', 'sourceQuote'], 'unknown'),
    lastSeen: readConflictString(record, ['LastReinforced', 'lastSeen', 'last_seen', 'CreatedAt', 'created_at']) || undefined,
    factType: readConflictString(record, ['FactType', 'factType', 'fact_type']) || undefined,
  };
}

function normalizeFlatConflictFact(record: Record<string, unknown>, prefix: 'fact_a' | 'fact_b'): ConflictFact | null {
  const id = readConflictNumber(record, [`${prefix}_id`, `${prefix}Id`]);
  const subject = readConflictString(record, [`${prefix}_subject`, `${prefix}Subject`]);
  const predicate = readConflictString(record, [`${prefix}_predicate`, `${prefix}Predicate`]);
  const object = readConflictString(record, [`${prefix}_object`, `${prefix}Object`]);

  if (!id || !subject || !predicate || !object) return null;

  return {
    id,
    subject,
    predicate,
    object,
    confidence: readConflictNumber(record, [`${prefix}_confidence`, `${prefix}Confidence`], 0),
    source: readConflictString(record, [`${prefix}_source`, `${prefix}_source_quote`, `${prefix}Source`, `${prefix}SourceQuote`], 'unknown'),
    lastSeen: readConflictString(record, [`${prefix}_last_seen`, `${prefix}_last_reinforced`, `${prefix}LastSeen`, `${prefix}LastReinforced`, `${prefix}_created_at`]) || undefined,
    factType: readConflictString(record, [`${prefix}_fact_type`, `${prefix}FactType`]) || undefined,
  };
}

export function parseConflictPairs(result: unknown): ConflictPair[] {
  if (!Array.isArray(result)) return [];

  return result.flatMap((entry): ConflictPair[] => {
    const record = asRecord(entry);
    if (!record) return [];

    const factA =
      normalizeNestedConflictFact(record['fact1']) ??
      normalizeNestedConflictFact(record['factA']) ??
      normalizeFlatConflictFact(record, 'fact_a');

    const factB =
      normalizeNestedConflictFact(record['fact2']) ??
      normalizeNestedConflictFact(record['factB']) ??
      normalizeFlatConflictFact(record, 'fact_b');

    return factA && factB ? [{ factA, factB }] : [];
  });
}

export function formatConflictDate(value?: string) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
