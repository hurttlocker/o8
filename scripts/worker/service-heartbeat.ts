import { setTimeout as delay } from 'node:timers/promises';
import { isTransientTransportError, type CloudWorkerJob, type EventStream } from './event-stream';

const MAX_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 100;

export class HeartbeatAuthorityExpired extends Error {
  constructor(firstFailure?: Error) {
    super(`${firstFailure ? `${firstFailure.message}; ` : ''}lease renewal was not confirmed before expiry`, { cause: firstFailure });
    this.name = 'HeartbeatAuthorityExpired';
  }
}

/** Only fresh claim-bound heartbeats may recover a lost acknowledgement.
 * The server revalidates the credential, worker and unexpired claim on each
 * renewal. No task output or terminal mutation is replayed. Until a response
 * is received, all attempts share the previous acknowledged authority bound.
 */
export async function renewServiceHeartbeat(
  stream: Pick<EventStream, 'postEvent'>,
  job: CloudWorkerJob,
  options: { signal: AbortSignal; confirmedUntil: number; onTransportFailure?: (error: Error) => void },
): Promise<string | null> {
  let firstFailure: Error | undefined;
  const authority = new AbortController();
  const active = AbortSignal.any([options.signal, authority.signal]);
  const checkAuthority = () => {
    options.signal.throwIfAborted();
    if (!Number.isFinite(options.confirmedUntil) || Date.now() >= options.confirmedUntil || authority.signal.aborted) {
      throw new HeartbeatAuthorityExpired(firstFailure);
    }
  };
  checkAuthority();
  const timer = setTimeout(() => authority.abort(new HeartbeatAuthorityExpired(firstFailure)), options.confirmedUntil - Date.now());
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      checkAuthority();
      try {
        const expiry = await stream.postEvent(job, 'heartbeat', { status: 'running' }, active);
        // A late ACK must not restore authority after the old confirmed bound.
        checkAuthority();
        return expiry;
      } catch (error) {
        checkAuthority();
        if (!isTransientTransportError(error)) throw error;
        firstFailure ??= error as Error;
        options.onTransportFailure?.(firstFailure);
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(`${firstFailure.message}; heartbeat transport recovery exhausted after ${MAX_ATTEMPTS} attempts`, { cause: firstFailure });
        }
        try { await delay(INITIAL_BACKOFF_MS * 2 ** (attempt - 1), undefined, { signal: active }); }
        catch { checkAuthority(); throw active.reason; }
      }
    }
    throw new Error('[worker] heartbeat recovery loop exited unexpectedly');
  } finally { clearTimeout(timer); }
}
