import { isLocalWorkerToken } from './worker-token';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { readActiveTokenHashes } from '@/lib/mobile/device-token-file';

export type RequestPrincipal = 'operator' | 'worker' | 'device' | 'anonymous';

function tokenMatches(presented: string, expected: string): boolean {
  const left = Buffer.from(presented, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function isDeviceToken(presented: string): boolean {
  if (!presented) return false;
  const hash = createHash('sha256').update(presented).digest('hex');
  return readActiveTokenHashes().has(hash);
}

/**
 * Resolve the caller's principal for governance authorization. A dispatched
 * worker presents the local-worker token (O8_WORKER_TOKEN, attached by its
 * `o8` CLI). Operator and device authority require an affirmative bearer match;
 * an absent or unknown credential is anonymous even when the socket is loopback.
 *
 * Fail-closed by construction: loopback location is transport evidence, not an
 * identity. This prevents a worker from becoming an operator by omitting its
 * worker token when calling a governance route directly.
 *
 * Accepts a plain `Request` (NextRequest is one) so both App-Router handlers
 * and the `Request`-typed panel routes share one resolver.
 */
export function resolveRequestPrincipal(req: Request): RequestPrincipal {
  const auth = req.headers.get('authorization');
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (isLocalWorkerToken(bearer)) return 'worker';
  if (bearer && tokenMatches(bearer, getOrCreateWsToken().trim())) return 'operator';
  if (isDeviceToken(bearer)) return 'device';
  return 'anonymous';
}
