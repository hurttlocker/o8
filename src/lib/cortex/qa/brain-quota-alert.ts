import {
  buildCrossHouseFallbackMessage,
  isRuntimeQuotaLimitError,
  resolveCrossHouseFallback,
  type CrossHouse,
} from '@/lib/orchestrator/cross-house-policy';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';

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
const emitted = new Set<CrossHouse>();

export function noteBrainQuotaError(error: unknown, fromHouse: CrossHouse): boolean {
  if (!isRuntimeQuotaLimitError(error) || emitted.has(fromHouse) || pending.has(fromHouse)) return false;
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
    if (emitted.has(house)) continue;
    emit('alert', alert);
    emitted.add(house);
    pending.delete(house);
    count += 1;
  }
  return count;
}

export function resetBrainQuotaAlertsForTests(): void {
  pending.clear();
  emitted.clear();
}
