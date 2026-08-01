import 'server-only';

import { randomUUID } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import type {
  HarnessComponentLifecycle,
  HarnessComponentState,
  HarnessLifecycleRecommendation,
  HarnessMeasurement,
} from './types';

interface ComponentRow {
  component_key: string;
  model_id: string;
  lifecycle: HarnessComponentLifecycle;
  reason: string;
  updated_at: number;
}

interface MeasurementRow {
  id: string;
  component_key: string;
  model_id: string;
  baseline_score: number;
  enabled_score: number;
  lift: number;
  sample_count: number;
  evidence_json: string;
  created_at: number;
}

function cleanKey(value: string, field: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${field} is required`);
  if (clean.length > 200) throw new Error(`${field} exceeds 200 characters`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(clean)) {
    throw new Error(`${field} contains unsupported characters`);
  }
  return clean;
}

function finiteScore(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite`);
  if (Math.abs(value) > 1_000_000) throw new Error(`${field} is outside the supported range`);
  return value;
}

function parseEvidence(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function rowToMeasurement(row: MeasurementRow): HarnessMeasurement {
  return {
    id: row.id,
    componentKey: row.component_key,
    modelId: row.model_id,
    baselineScore: row.baseline_score,
    enabledScore: row.enabled_score,
    lift: row.lift,
    sampleCount: row.sample_count,
    evidence: parseEvidence(row.evidence_json),
    createdAt: row.created_at,
  };
}

export function listMeasurements(input: {
  componentKey?: string | null;
  modelId?: string | null;
  limit?: number;
} = {}): HarnessMeasurement[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input.componentKey) {
    conditions.push('component_key = ?');
    params.push(cleanKey(input.componentKey, 'componentKey'));
  }
  if (input.modelId) {
    conditions.push('model_id = ?');
    params.push(cleanKey(input.modelId, 'modelId'));
  }
  const limit = Math.max(1, Math.min(1_000, input.limit ?? 200));
  const sql = `
    SELECT * FROM harness_measurements
    ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `;
  const rows = getSqlite().prepare(sql).all(...params, limit) as MeasurementRow[];
  return rows.map(rowToMeasurement);
}

function weightedLiftFor(componentKey: string, modelId: string): {
  measurementCount: number;
  sampleCount: number;
  weightedLift: number | null;
} {
  const row = getSqlite().prepare(`
    SELECT COUNT(*) AS measurement_count,
           COALESCE(SUM(sample_count), 0) AS sample_count,
           CASE WHEN SUM(sample_count) > 0
             THEN SUM(lift * sample_count) / SUM(sample_count)
             ELSE NULL
           END AS weighted_lift
      FROM harness_measurements
     WHERE component_key = ? AND model_id = ?
  `).get(componentKey, modelId) as {
    measurement_count: number;
    sample_count: number;
    weighted_lift: number | null;
  };
  return {
    measurementCount: row.measurement_count,
    sampleCount: row.sample_count,
    weightedLift: row.weighted_lift,
  };
}

export function recommendLifecycle(input: {
  lifecycle: HarnessComponentLifecycle;
  weightedLift: number | null;
  sampleCount: number;
}): HarnessLifecycleRecommendation {
  if (input.weightedLift === null || input.sampleCount < 10) {
    return { action: 'measure_more', reason: `Only ${input.sampleCount} paired samples are available; collect at least 10.` };
  }
  if (input.lifecycle === 'retired') {
    return input.weightedLift >= 0.02
      ? { action: 'rearm', reason: `Shadow evidence shows ${(input.weightedLift * 100).toFixed(2)} percentage points of lift.` }
      : { action: 'retain', reason: 'The retired component has not recovered measurable lift.' };
  }
  if (input.weightedLift >= 0.02) {
    return { action: 'retain', reason: `Measured lift is ${(input.weightedLift * 100).toFixed(2)} percentage points.` };
  }
  if (input.weightedLift > 0) {
    return { action: 'candidate', reason: 'Lift is positive but below the two-point retention threshold.' };
  }
  if (input.lifecycle === 'retained') {
    return { action: 'candidate', reason: 'Paired measurements show no positive lift; move to candidate before shadowing.' };
  }
  if (input.lifecycle === 'candidate') {
    return { action: 'shadow_only', reason: 'Candidate measurements remain non-positive; compare in shadow mode.' };
  }
  return { action: 'retire', reason: 'Shadow-only measurements remain non-positive with enough paired samples.' };
}

function ensureComponent(componentKey: string, modelId: string): ComponentRow {
  const key = cleanKey(componentKey, 'componentKey');
  const model = cleanKey(modelId, 'modelId');
  const now = Date.now();
  getSqlite().prepare(`
    INSERT INTO harness_components (component_key, model_id, lifecycle, reason, updated_at)
    VALUES (?, ?, 'retained', '', ?)
    ON CONFLICT(component_key, model_id) DO NOTHING
  `).run(key, model, now);
  return getSqlite().prepare(`
    SELECT * FROM harness_components WHERE component_key = ? AND model_id = ?
  `).get(key, model) as ComponentRow;
}

function rowToComponent(row: ComponentRow): HarnessComponentState {
  const aggregate = weightedLiftFor(row.component_key, row.model_id);
  return {
    componentKey: row.component_key,
    modelId: row.model_id,
    lifecycle: row.lifecycle,
    reason: row.reason,
    updatedAt: row.updated_at,
    measurementCount: aggregate.measurementCount,
    weightedLift: aggregate.weightedLift,
    recommendation: recommendLifecycle({
      lifecycle: row.lifecycle,
      weightedLift: aggregate.weightedLift,
      sampleCount: aggregate.sampleCount,
    }),
  };
}

export function getComponent(componentKey: string, modelId: string): HarnessComponentState {
  return rowToComponent(ensureComponent(componentKey, modelId));
}

export function listComponents(): HarnessComponentState[] {
  const rows = getSqlite().prepare(`
    SELECT * FROM harness_components ORDER BY component_key, model_id
  `).all() as ComponentRow[];
  return rows.map(rowToComponent);
}

export function recordMeasurement(input: {
  componentKey: string;
  modelId: string;
  baselineScore: number;
  enabledScore: number;
  sampleCount: number;
  evidence?: Record<string, unknown>;
}): { measurement: HarnessMeasurement; component: HarnessComponentState } {
  const componentKey = cleanKey(input.componentKey, 'componentKey');
  const modelId = cleanKey(input.modelId, 'modelId');
  const baseline = finiteScore(input.baselineScore, 'baselineScore');
  const enabled = finiteScore(input.enabledScore, 'enabledScore');
  if (!Number.isInteger(input.sampleCount) || input.sampleCount < 1 || input.sampleCount > 1_000_000) {
    throw new Error('sampleCount must be an integer between 1 and 1000000');
  }
  ensureComponent(componentKey, modelId);
  const id = `measurement-${randomUUID()}`;
  getSqlite().prepare(`
    INSERT INTO harness_measurements (
      id, component_key, model_id, baseline_score, enabled_score,
      lift, sample_count, evidence_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    componentKey,
    modelId,
    baseline,
    enabled,
    enabled - baseline,
    input.sampleCount,
    JSON.stringify(input.evidence ?? {}),
    Date.now(),
  );
  const measurement = listMeasurements({ componentKey, modelId, limit: 1 })[0];
  return { measurement, component: getComponent(componentKey, modelId) };
}

export function transitionComponent(input: {
  componentKey: string;
  modelId: string;
  lifecycle: HarnessComponentLifecycle;
  reason: string;
}): HarnessComponentState {
  const current = getComponent(input.componentKey, input.modelId);
  const allowed: Record<HarnessComponentLifecycle, HarnessComponentLifecycle[]> = {
    retained: ['candidate'],
    candidate: ['retained', 'shadow_only'],
    shadow_only: ['retained', 'candidate', 'retired'],
    retired: ['retained'],
  };
  if (current.lifecycle === input.lifecycle) return current;
  if (!allowed[current.lifecycle].includes(input.lifecycle)) {
    throw new Error(`invalid component transition: ${current.lifecycle} -> ${input.lifecycle}`);
  }
  const reason = input.reason.trim();
  if (!reason) throw new Error('reason is required for a lifecycle transition');
  if (input.lifecycle === 'retired' && current.recommendation.action !== 'retire') {
    throw new Error(`component is not ready to retire: ${current.recommendation.reason}`);
  }
  getSqlite().prepare(`
    UPDATE harness_components
       SET lifecycle = ?, reason = ?, updated_at = ?
     WHERE component_key = ? AND model_id = ?
  `).run(
    input.lifecycle,
    reason.slice(0, 2_000),
    Date.now(),
    current.componentKey,
    current.modelId,
  );
  return getComponent(current.componentKey, current.modelId);
}
