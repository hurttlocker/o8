import {
  TASK_ARTIFACT_ACTION_NAME_PATTERN,
  TASK_ARTIFACT_LIMITS,
  type TaskArtifactActionSchema,
  type TaskArtifactDeclaredAction,
  type TaskArtifactFieldSchema,
} from './types';

export type SchemaValidation =
  | { ok: true }
  | { ok: false; errors: string[] };

const FIELD_TYPES = new Set(['string', 'number', 'integer', 'boolean']);
const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateFieldSchema(path: string, raw: unknown, errors: string[]): TaskArtifactFieldSchema | null {
  if (!isRecord(raw)) { errors.push(`${path}: field schema must be an object`); return null; }
  if (typeof raw.type !== 'string' || !FIELD_TYPES.has(raw.type)) {
    errors.push(`${path}.type: expected one of string, number, integer, boolean`);
    return null;
  }
  const schema: TaskArtifactFieldSchema = { type: raw.type as TaskArtifactFieldSchema['type'] };
  if (raw.required !== undefined) {
    if (typeof raw.required !== 'boolean') errors.push(`${path}.required: expected boolean`);
    else schema.required = raw.required;
  }
  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || raw.enum.length === 0 || raw.enum.length > 64
      || !raw.enum.every((v) => typeof v === 'string' || typeof v === 'number')) {
      errors.push(`${path}.enum: expected a non-empty array of up to 64 strings or numbers`);
    } else {
      schema.enum = raw.enum as Array<string | number>;
    }
  }
  for (const key of ['maxLength', 'min', 'max'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) errors.push(`${path}.${key}: expected a finite number`);
    else schema[key] = raw[key] as number;
  }
  return schema;
}

function validateFieldMap(path: string, raw: unknown, errors: string[]): Record<string, TaskArtifactFieldSchema> | null {
  if (!isRecord(raw)) { errors.push(`${path}: expected an object of field schemas`); return null; }
  const names = Object.keys(raw);
  if (names.length === 0) { errors.push(`${path}: at least one field is required`); return null; }
  if (names.length > TASK_ARTIFACT_LIMITS.maxFieldsPerSchema) {
    errors.push(`${path}: at most ${TASK_ARTIFACT_LIMITS.maxFieldsPerSchema} fields`);
    return null;
  }
  const out: Record<string, TaskArtifactFieldSchema> = {};
  for (const name of names) {
    if (!FIELD_NAME_PATTERN.test(name)) { errors.push(`${path}.${name}: invalid field name`); continue; }
    const field = validateFieldSchema(`${path}.${name}`, raw[name], errors);
    if (field) out[name] = field;
  }
  return out;
}

/** Normalize and validate one declared action's schema. */
export function normalizeActionSchema(raw: unknown): { ok: true; schema: TaskArtifactActionSchema } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['schema must be an object'] };
  const fields = validateFieldMap('schema.fields', raw.fields, errors);
  let rows: TaskArtifactActionSchema['rows'];
  if (raw.rows !== undefined) {
    if (!isRecord(raw.rows)) {
      errors.push('schema.rows: expected an object');
    } else {
      const rowFields = validateFieldMap('schema.rows.fields', raw.rows.fields, errors);
      let maxRows: number | undefined;
      if (raw.rows.maxRows !== undefined) {
        if (!Number.isInteger(raw.rows.maxRows) || (raw.rows.maxRows as number) < 1
          || (raw.rows.maxRows as number) > TASK_ARTIFACT_LIMITS.maxRowsPerPayload) {
          errors.push(`schema.rows.maxRows: expected an integer from 1 to ${TASK_ARTIFACT_LIMITS.maxRowsPerPayload}`);
        } else {
          maxRows = raw.rows.maxRows as number;
        }
      }
      if (rowFields) rows = { fields: rowFields, ...(maxRows ? { maxRows } : {}) };
    }
  }
  if (errors.length > 0 || !fields) return { ok: false, errors };
  return { ok: true, schema: { fields, ...(rows ? { rows } : {}) } };
}

/** Normalize and validate the declared-action list an agent sends at creation. */
export function normalizeDeclaredActions(raw: unknown): { ok: true; actions: TaskArtifactDeclaredAction[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(raw)) return { ok: false, errors: ['actions must be an array'] };
  if (raw.length === 0) return { ok: false, errors: ['at least one action must be declared'] };
  if (raw.length > TASK_ARTIFACT_LIMITS.maxDeclaredActions) {
    return { ok: false, errors: [`at most ${TASK_ARTIFACT_LIMITS.maxDeclaredActions} actions`] };
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  const actions: TaskArtifactDeclaredAction[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) { errors.push(`actions[${index}]: expected an object`); return; }
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (!TASK_ARTIFACT_ACTION_NAME_PATTERN.test(name)) { errors.push(`actions[${index}].name: invalid`); return; }
    if (seen.has(name)) { errors.push(`actions[${index}].name: duplicate "${name}"`); return; }
    seen.add(name);
    const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim().slice(0, 60) : undefined;
    const schema = normalizeActionSchema(entry.schema);
    if (!schema.ok) { errors.push(...schema.errors.map((e) => `actions[${index}].${e}`)); return; }
    actions.push({ name, ...(label ? { label } : {}), schema: schema.schema });
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, actions };
}

function checkField(path: string, schema: TaskArtifactFieldSchema, value: unknown, errors: string[]): void {
  if (value === undefined || value === null) {
    if (schema.required) errors.push(`${path}: required`);
    return;
  }
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') { errors.push(`${path}: expected string`); return; }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
      break;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push(`${path}: expected ${schema.type}`); return; }
      if (schema.type === 'integer' && !Number.isInteger(value)) { errors.push(`${path}: expected integer`); return; }
      if (schema.min !== undefined && value < schema.min) errors.push(`${path}: below ${schema.min}`);
      if (schema.max !== undefined && value > schema.max) errors.push(`${path}: above ${schema.max}`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') { errors.push(`${path}: expected boolean`); return; }
      break;
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    errors.push(`${path}: not one of ${schema.enum.join(', ')}`);
  }
}

function checkObject(path: string, fields: Record<string, TaskArtifactFieldSchema>, value: unknown, errors: string[]): void {
  if (!isRecord(value)) { errors.push(`${path}: expected an object`); return; }
  for (const key of Object.keys(value)) {
    if (!(key in fields)) errors.push(`${path}.${key}: not declared`);
  }
  for (const [name, schema] of Object.entries(fields)) {
    checkField(`${path}.${name}`, schema, value[name], errors);
  }
}

/**
 * Validate a submitted payload against a declared action schema. Undeclared
 * keys are errors: the frame may only send what the agent declared.
 */
export function validateActionPayload(schema: TaskArtifactActionSchema, payload: unknown): SchemaValidation {
  const errors: string[] = [];
  if (!isRecord(payload)) return { ok: false, errors: ['payload: expected an object'] };
  const { rows, ...rest } = payload;
  checkObject('payload', schema.fields, rest, errors);
  if (schema.rows) {
    if (rows === undefined) {
      errors.push('payload.rows: required');
    } else if (!Array.isArray(rows)) {
      errors.push('payload.rows: expected an array');
    } else {
      const maxRows = schema.rows.maxRows ?? TASK_ARTIFACT_LIMITS.maxRowsPerPayload;
      if (rows.length > maxRows) errors.push(`payload.rows: more than ${maxRows} rows`);
      rows.slice(0, maxRows).forEach((row, index) => checkObject(`payload.rows[${index}]`, schema.rows!.fields, row, errors));
    }
  } else if (rows !== undefined) {
    errors.push('payload.rows: not declared');
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
