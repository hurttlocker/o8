import {
  buildCrossHouseFallbackMessage,
  isRuntimeQuotaLimitError,
  resolveCrossHouseFallback,
  type CrossHouse,
} from '@/lib/orchestrator/cross-house-policy';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { getSqlite } from '@/lib/db';

interface BrainQuotaAlert {
  id: string;
  kind: 'brain_subscription_fallback';
  message: string;
  fromHouse: CrossHouse;
  toHouse: CrossHouse;
  fromModel: string;
  toModel: string;
}

const pending = new Map<CrossHouse, BrainQuotaAlert>();
export const BRAIN_QUOTA_ALERT_COOLDOWN_MS = 6 * 60 * 60_000;

function stateKey(house: CrossHouse): string {
  return `brain_quota_alert_last_at:${house}`;
}

function lastAlertAt(house: CrossHouse): number | null {
  try {
    const row = getSqlite().prepare(
      'SELECT value FROM app_state WHERE key = ? LIMIT 1',
    ).get(stateKey(house)) as { value?: string } | undefined;
    const value = Number(row?.value);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function persistAlertAt(house: CrossHouse, timestamp: number): void {
  getSqlite().prepare(`
    INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(stateKey(house), String(timestamp), timestamp);
}

export function noteBrainQuotaError(error: unknown, fromHouse: CrossHouse): boolean {
  if (!isRuntimeQuotaLimitError(error) || pending.has(fromHouse)) return false;
  const previous = lastAlertAt(fromHouse);
  if (previous !== null && Date.now() - previous < BRAIN_QUOTA_ALERT_COOLDOWN_MS) return false;
  const decision = resolveCrossHouseFallback({
    role: 'brain',
    backend: fromHouse === 'anthropic' ? 'claude' : 'codex',
    subscriptionProfile: getOperatorDefaultsSync().values.subscriptionProfile,
  });
  if (!decision) return false;
  pending.set(fromHouse, {
    id: `brain-quota-${fromHouse}`,
    kind: 'brain_subscription_fallback',
    message: buildCrossHouseFallbackMessage(decision),
    fromHouse,
    toHouse: decision.toHouse,
    fromModel: decision.fromModel,
    toModel: decision.toModel,
  });
  return true;
}

export function flushBrainQuotaAlerts(emit: (name: string, payload: unknown) => void): number {
  let count = 0;
  for (const [house, alert] of pending) {
    emit('alert', alert);
    persistAlertAt(house, Date.now());
    pending.delete(house);
    count += 1;
  }
  return count;
}

export function resetBrainQuotaAlertsForTests(): void {
  pending.clear();
  try {
    getSqlite().prepare("DELETE FROM app_state WHERE key LIKE 'brain_quota_alert_last_at:%'").run();
  } catch {
    // Tests that have not initialized SQLite have no persisted state to clear.
  }
}
