/**
 * Managed judgment allowance and public-beta end date (#2486, child 4 of
 * #2452). Both are operator settings, not code constants, and both default to
 * null, meaning "not configured": a null allowance makes no client-side
 * allowance assumption (the proxy's cap response is the only limit), and a
 * null end date means the beta does not expire.
 */
export interface JudgmentAllowanceDefaults {
  /** Managed judgment calls per install per day. Null = not configured. */
  judgmentManagedDailyAllowance: number | null;
  /** Last day (YYYY-MM-DD, UTC) of the public beta. Null = no expiry. */
  judgmentBetaEndDate: string | null;
}

export const JUDGMENT_ALLOWANCE_FALLBACK: JudgmentAllowanceDefaults = {
  judgmentManagedDailyAllowance: null,
  judgmentBetaEndDate: null,
};

export const JUDGMENT_ALLOWANCE_EXPECTED = 'an integer greater than 0, or null';
export const JUDGMENT_BETA_END_DATE_EXPECTED = 'an ISO date (YYYY-MM-DD), or null';

export function isJudgmentAllowance(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isJudgmentBetaEndDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** True once the UTC date is later than the configured end date; false when none is set. */
export function isJudgmentBetaEnded(endDate: string | null, now: Date = new Date()): boolean {
  return endDate !== null && now.toISOString().slice(0, 10) > endDate;
}

export function resolveStoredJudgmentAllowance(
  stored: Partial<JudgmentAllowanceDefaults>,
): Partial<JudgmentAllowanceDefaults> {
  const allowance = stored.judgmentManagedDailyAllowance;
  const endDate = stored.judgmentBetaEndDate;
  return {
    ...(allowance === null || isJudgmentAllowance(allowance) ? { judgmentManagedDailyAllowance: allowance } : {}),
    ...(endDate === null || isJudgmentBetaEndDate(endDate) ? { judgmentBetaEndDate: endDate } : {}),
  };
}

export function resolveJudgmentAllowanceSettings(file: Partial<JudgmentAllowanceDefaults>) {
  return {
    values: {
      judgmentManagedDailyAllowance: file.judgmentManagedDailyAllowance !== undefined
        ? file.judgmentManagedDailyAllowance
        : JUDGMENT_ALLOWANCE_FALLBACK.judgmentManagedDailyAllowance,
      judgmentBetaEndDate: file.judgmentBetaEndDate !== undefined
        ? file.judgmentBetaEndDate
        : JUDGMENT_ALLOWANCE_FALLBACK.judgmentBetaEndDate,
    },
    sources: {
      judgmentManagedDailyAllowance: file.judgmentManagedDailyAllowance !== undefined ? 'file' as const : 'default' as const,
      judgmentBetaEndDate: file.judgmentBetaEndDate !== undefined ? 'file' as const : 'default' as const,
    },
  };
}

export function applyJudgmentAllowanceUpdate(
  stored: Partial<JudgmentAllowanceDefaults>,
  update: Partial<JudgmentAllowanceDefaults>,
): void {
  if (update.judgmentManagedDailyAllowance !== undefined) {
    if (update.judgmentManagedDailyAllowance !== null && !isJudgmentAllowance(update.judgmentManagedDailyAllowance)) {
      throw new Error(`judgmentManagedDailyAllowance must be ${JUDGMENT_ALLOWANCE_EXPECTED}.`);
    }
    stored.judgmentManagedDailyAllowance = update.judgmentManagedDailyAllowance;
  }
  if (update.judgmentBetaEndDate !== undefined) {
    if (update.judgmentBetaEndDate !== null && !isJudgmentBetaEndDate(update.judgmentBetaEndDate)) {
      throw new Error(`judgmentBetaEndDate must be ${JUDGMENT_BETA_END_DATE_EXPECTED}.`);
    }
    stored.judgmentBetaEndDate = update.judgmentBetaEndDate;
  }
}
