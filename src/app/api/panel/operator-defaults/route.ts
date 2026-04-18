import { NextResponse } from 'next/server';

import {
  getOperatorDefaults,
  updateOperatorDefaults,
  type OperatorDefaults,
  type OverlapGateMode,
} from '@/lib/operator/defaults';
import { isThinkingEffort } from '@/lib/orchestrator/thinking-effort';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

function response(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUpdate(body: Record<string, unknown>): Partial<OperatorDefaults> {
  const update: Partial<OperatorDefaults> = {};

  if (body.parallelCap !== undefined) {
    const raw = body.parallelCap;
    const parsed = typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number.parseInt(raw, 10)
        : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 32) {
      throw new Error('parallelCap must be an integer between 1 and 32.');
    }
    update.parallelCap = Math.floor(parsed);
  }

  if (body.overlapGate !== undefined) {
    if (body.overlapGate !== 'advisory' && body.overlapGate !== 'strict') {
      throw new Error('overlapGate must be "advisory" or "strict".');
    }
    update.overlapGate = body.overlapGate as OverlapGateMode;
  }

  if (body.healBotEnabled !== undefined) {
    if (typeof body.healBotEnabled !== 'boolean') {
      throw new Error('healBotEnabled must be boolean.');
    }
    update.healBotEnabled = body.healBotEnabled;
  }

  if (body.supervisorAutoEscalate !== undefined) {
    if (typeof body.supervisorAutoEscalate !== 'boolean') {
      throw new Error('supervisorAutoEscalate must be boolean.');
    }
    update.supervisorAutoEscalate = body.supervisorAutoEscalate;
  }

  if (body.thinkingEffort !== undefined) {
    if (!isThinkingEffort(body.thinkingEffort)) {
      throw new Error('thinkingEffort must be a valid effort level.');
    }
    update.thinkingEffort = body.thinkingEffort;
  }

  if (body.promptCachingEnabled !== undefined) {
    if (typeof body.promptCachingEnabled !== 'boolean') {
      throw new Error('promptCachingEnabled must be boolean.');
    }
    update.promptCachingEnabled = body.promptCachingEnabled;
  }

  if (body.orchestratorModel !== undefined) {
    if (typeof body.orchestratorModel !== 'string' || !body.orchestratorModel.trim()) {
      throw new Error('orchestratorModel must be a non-empty string.');
    }
    update.orchestratorModel = body.orchestratorModel.trim();
  }

  return update;
}

export async function GET() {
  try {
    const data = await getOperatorDefaults();
    return response(data);
  } catch (error) {
    console.error('[panel-operator-defaults] Failed to load operator defaults:', error);
    return response({ error: 'Failed to load operator defaults.' }, 500);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!isRecord(body)) {
      return response({ error: 'Invalid request body.' }, 400);
    }

    const update = normalizeUpdate(body);
    if (Object.keys(update).length === 0) {
      return response({ error: 'No supported fields in request body.' }, 400);
    }

    const updated = await updateOperatorDefaults(update);
    return response(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update operator defaults.';
    console.error('[panel-operator-defaults] Failed to update operator defaults:', message);
    return response({ error: message }, 400);
  }
}
