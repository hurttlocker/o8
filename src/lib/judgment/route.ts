/**
 * Judgment route resolver and enabled check (#2484, child 2 of #2452).
 *
 * `managed` mirrors `resolveOpenRouterRoute`: a plan token (entitlement with
 * the inference-proxy flag) or else a free allowance token sends the call to
 * `${proxyBaseUrl()}/v1/judgment` with that bearer and no provider key; with
 * neither, the operator's own key goes direct. `typesafe` always goes direct,
 * so its requests are unchanged. Past the operator's beta end date (#2486) a
 * free install skips the allowance token and goes straight to its key.
 */
import { freeAllowanceToken, planToken, proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { isJudgmentBetaEnded } from '@/lib/operator/judgment-allowance-default';
import type { JudgmentProvider } from '@/lib/operator/judgment-default';
import { readJudgmentApiKey } from './key';
import type { JudgmentRoute } from './types';

export const TYPESAFE_SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';

export interface ResolvedJudgmentRoute {
  url: string;
  bearer: string;
  route: JudgmentRoute;
  /** Which credential carries the call: the plan token, the free allowance token, or the local key. */
  credential: 'plan' | 'allowance' | 'key';
}

/** The path a judgment call takes right now: off, a credential, or `none` when enabled with no credential. */
export type JudgmentPath = 'off' | ResolvedJudgmentRoute['credential'] | 'none';

/** The judgment route for an enabled provider, or null when no credential exists. */
export function resolveJudgmentRoute(
  provider: Exclude<JudgmentProvider, 'off'>,
  directUrl: string = TYPESAFE_SYSTEMONE_URL,
): ResolvedJudgmentRoute | null {
  if (provider === 'managed') {
    const betaEnded = isJudgmentBetaEnded(getOperatorDefaultsSync().values.judgmentBetaEndDate);
    const plan = planToken();
    const token = plan ?? (betaEnded ? null : freeAllowanceToken());
    if (token) return { url: `${proxyBaseUrl()}/v1/judgment`, bearer: token, route: 'managed', credential: plan ? 'plan' : 'allowance' };
  }
  return resolveDirectJudgmentRoute(directUrl);
}

/** The operator's own key on the direct route, or null when no key exists. */
export function resolveDirectJudgmentRoute(directUrl: string = TYPESAFE_SYSTEMONE_URL): ResolvedJudgmentRoute | null {
  const key = readJudgmentApiKey();
  return key ? { url: directUrl, bearer: key, route: 'direct', credential: 'key' } : null;
}

/** The judgment path for the Settings subtitle, read from the same resolver the client calls. */
export function resolveJudgmentPath(provider: JudgmentProvider): JudgmentPath {
  if (provider === 'off') return 'off';
  return resolveJudgmentRoute(provider)?.credential ?? 'none';
}

/** Whether any judgment referee may run: true for `typesafe` and `managed`, false for `off` or an unreadable setting. */
export function isJudgmentRefereeEnabled(): boolean {
  try {
    return getOperatorDefaultsSync().values.judgmentProvider !== 'off';
  } catch {
    return false;
  }
}
