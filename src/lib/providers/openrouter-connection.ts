/**
 * OpenRouter connection record (#3583).
 *
 * One non-secret file per install records whether o8 may use the connected
 * OpenRouter key and what the last key check returned. The key itself stays in
 * the encrypted env store; this file holds only a short fingerprint so a later
 * key change is visible as unverified. The native app reads `enabled` from the
 * same file, so turning the connection off stops every o8 OpenRouter caller.
 */

import 'server-only';

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
const CHECK_TIMEOUT_MS = 8_000;

export type OpenRouterConnectionState = 'disconnected' | 'configured-unverified' | 'connected' | 'degraded' | 'disabled';
export type OpenRouterCheckStatus = 'ok' | 'invalid' | 'unavailable';

/** Fields copied from `GET /api/v1/key`. They describe the key, including use outside o8. */
export interface OpenRouterKeyDetails {
  limit: number | null;
  limitRemaining: number | null;
  limitReset: string | null;
  usage: number | null;
  usageDaily: number | null;
  usageWeekly: number | null;
  usageMonthly: number | null;
  isFreeTier: boolean | null;
  isManagementKey: boolean | null;
  expiresAt: string | null;
}

export interface OpenRouterConnectionRecord {
  version: 1;
  enabled: boolean;
  keyFingerprint: string | null;
  checkStatus: OpenRouterCheckStatus | null;
  checkedAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  details: OpenRouterKeyDetails | null;
}

export interface OpenRouterCheckResult {
  status: OpenRouterCheckStatus;
  error: string | null;
  details: OpenRouterKeyDetails | null;
}

export interface OpenRouterConnectionView {
  state: OpenRouterConnectionState;
  enabled: boolean;
  checkedAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  details: OpenRouterKeyDetails | null;
}

const EMPTY_RECORD: OpenRouterConnectionRecord = {
  version: 1, enabled: true, keyFingerprint: null, checkStatus: null, checkedAt: null, lastOkAt: null, lastError: null, details: null,
};

function recordPath(): string {
  return join(getDataDir(), 'providers', 'openrouter.json');
}

export function openRouterKeyFingerprint(key: string): string {
  return createHash('sha256').update(key.trim()).digest('hex').slice(0, 12);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function detailsFrom(value: unknown): OpenRouterKeyDetails | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  return {
    limit: numberOrNull(data.limit),
    limitRemaining: numberOrNull(data.limit_remaining ?? data.limitRemaining),
    limitReset: stringOrNull(data.limit_reset ?? data.limitReset),
    usage: numberOrNull(data.usage),
    usageDaily: numberOrNull(data.usage_daily ?? data.usageDaily),
    usageWeekly: numberOrNull(data.usage_weekly ?? data.usageWeekly),
    usageMonthly: numberOrNull(data.usage_monthly ?? data.usageMonthly),
    isFreeTier: booleanOrNull(data.is_free_tier ?? data.isFreeTier),
    isManagementKey: booleanOrNull(data.is_management_key ?? data.isManagementKey),
    expiresAt: stringOrNull(data.expires_at ?? data.expiresAt),
  };
}

/** Reads the record fresh on every call: the API, WebSocket and native processes share it. */
export function readOpenRouterConnection(): OpenRouterConnectionRecord {
  const path = recordPath();
  if (!existsSync(path)) return { ...EMPTY_RECORD };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<OpenRouterConnectionRecord>;
    const checkStatus = raw.checkStatus === 'ok' || raw.checkStatus === 'invalid' || raw.checkStatus === 'unavailable' ? raw.checkStatus : null;
    return {
      version: 1,
      enabled: raw.enabled !== false,
      keyFingerprint: stringOrNull(raw.keyFingerprint),
      checkStatus,
      checkedAt: stringOrNull(raw.checkedAt),
      lastOkAt: stringOrNull(raw.lastOkAt),
      lastError: stringOrNull(raw.lastError),
      details: detailsFrom(raw.details),
    };
  } catch {
    // An unreadable record must not turn a connection off or on by itself.
    return { ...EMPTY_RECORD };
  }
}

function writeOpenRouterConnection(record: OpenRouterConnectionRecord): OpenRouterConnectionRecord {
  const path = recordPath();
  mkdirSync(join(getDataDir(), 'providers'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return record;
}

/** False only after the operator turns the connection off. A missing record means on. */
export function isOpenRouterEnabled(): boolean {
  return readOpenRouterConnection().enabled;
}

export function setOpenRouterEnabled(enabled: boolean): OpenRouterConnectionRecord {
  return writeOpenRouterConnection({ ...readOpenRouterConnection(), enabled });
}

export function recordOpenRouterCheck(key: string, result: OpenRouterCheckResult, now = new Date()): OpenRouterConnectionRecord {
  const previous = readOpenRouterConnection();
  const fingerprint = openRouterKeyFingerprint(key);
  const sameKey = previous.keyFingerprint === fingerprint;
  const checkedAt = now.toISOString();
  return writeOpenRouterConnection({
    ...previous,
    keyFingerprint: fingerprint,
    checkStatus: result.status,
    checkedAt,
    lastOkAt: result.status === 'ok' ? checkedAt : sameKey ? previous.lastOkAt : null,
    lastError: result.error,
    // A failed check keeps the last good figures for the same key so the UI can show them as stale.
    details: result.details ?? (sameKey ? previous.details : null),
  });
}

/** Removing the key forgets its check results but keeps the operator's on/off choice. */
export function clearOpenRouterCheck(): OpenRouterConnectionRecord {
  const previous = readOpenRouterConnection();
  return writeOpenRouterConnection({ ...EMPTY_RECORD, enabled: previous.enabled });
}

export function openRouterConnectionView(
  key: string | null,
  record: OpenRouterConnectionRecord = readOpenRouterConnection(),
  now = new Date(),
): OpenRouterConnectionView {
  const base = { enabled: record.enabled, checkedAt: record.checkedAt, lastOkAt: record.lastOkAt, lastError: record.lastError, details: record.details };
  if (!record.enabled) return { ...base, state: 'disabled' };
  if (!key) return { ...base, state: 'disconnected', details: null };
  if (record.keyFingerprint !== openRouterKeyFingerprint(key) || !record.checkStatus) {
    return { ...base, state: 'configured-unverified', lastOkAt: null, details: null };
  }
  const expiresAt = record.details?.expiresAt ? Date.parse(record.details.expiresAt) : Number.NaN;
  if (record.checkStatus === 'ok') {
    return { ...base, state: Number.isFinite(expiresAt) && expiresAt <= now.getTime() ? 'degraded' : 'connected' };
  }
  return { ...base, state: record.lastOkAt ? 'degraded' : 'configured-unverified' };
}

/** One authenticated read of the key's own status. It is free and makes no model call. */
export async function checkOpenRouterKey(key: string, fetchImpl: typeof fetch = fetch): Promise<OpenRouterCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(OPENROUTER_KEY_URL, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      return { status: 'invalid', error: 'OpenRouter rejected this key.', details: null };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const reason = response.status === 402 ? 'OpenRouter reports no remaining credit for this key (402).'
        : response.status === 429 ? 'OpenRouter is rate limiting this key (429).'
          : `OpenRouter could not check this key (${response.status}).`;
      return { status: 'unavailable', error: reason, details: null };
    }
    const payload = await response.json().catch(() => null) as { data?: unknown } | null;
    const details = detailsFrom(payload?.data);
    return details
      ? { status: 'ok', error: null, details }
      : { status: 'unavailable', error: 'OpenRouter returned an unreadable key status.', details: null };
  } catch {
    return { status: 'unavailable', error: 'Could not reach OpenRouter to check this key.', details: null };
  } finally {
    clearTimeout(timer);
  }
}
