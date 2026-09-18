/**
 * Judgment route resolver and enabled check (#2484, child 2 of #2452).
 *
 * `managed` mirrors `resolveOpenRouterRoute`: a plan token (entitlement with
 * the inference-proxy flag) or else a free allowance token sends the call to
 * `${proxyBaseUrl()}/v1/judgment` with that bearer and no provider key; with
 * neither, the operator's own key goes direct. `typesafe` always goes direct,
 * so its requests are unchanged.
 */
import { freeAllowanceToken, planToken, proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import type { JudgmentProvider } from '@/lib/operator/judgment-default';
import { readJudgmentApiKey } from './key';
import type { JudgmentRoute } from './types';

export const TYPESAFE_SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';

export interface ResolvedJudgmentRoute {
  url: string;
  bearer: string;
  route: JudgmentRoute;
}

/** The judgment route for an enabled provider, or null when no credential exists. */
export function resolveJudgmentRoute(
  provider: Exclude<JudgmentProvider, 'off'>,
  directUrl: string = TYPESAFE_SYSTEMONE_URL,
): ResolvedJudgmentRoute | null {
  if (provider === 'managed') {
    const token = planToken() ?? freeAllowanceToken();
    if (token) return { url: `${proxyBaseUrl()}/v1/judgment`, bearer: token, route: 'managed' };
  }
  const key = readJudgmentApiKey();
  return key ? { url: directUrl, bearer: key, route: 'direct' } : null;
}

/** Whether any judgment referee may run: true for `typesafe` and `managed`, false for `off` or an unreadable setting. */
export function isJudgmentRefereeEnabled(): boolean {
  try {
    return getOperatorDefaultsSync().values.judgmentProvider !== 'off';
  } catch {
    return false;
  }
}
