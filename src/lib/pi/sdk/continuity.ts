import { isAbsolute, relative, resolve } from 'node:path';
import { deserialize, serialize } from 'node:v8';

export type PiContinuityAction = { name: 'write_file'; path: string }
  | { name: 'run_command'; command: string };
export interface PiSourceRead {
  workspace: string;
  path: string;
  /** Complete, losslessly decoded bytes returned by a successful host read_file. */
  bytes: Uint8Array;
}
export interface PiContinuityInspection {
  workspace: string;
  action: PiContinuityAction;
  intentRef: string;
  originalEvidence: unknown;
  reads: readonly PiSourceRead[];
}

/**
 * Trusted host adapter only. Nothing here may come from tool/model arguments.
 * The adapter owns source-evidence validation and must reject missing/malformed
 * evidence. `complete` means all dependencies of every possible action target
 * are covered; an arbitrary shell command with unknown scope must be refused.
 * A fresh result adds a precondition, never approval or execution authority.
 * Inspection must be read-only. Abort stops waiting even if the adapter does
 * not cooperate; a late result grants nothing and cannot resume the action.
 * Production handoff/admission integration is deliberately not wired here.
 */
export interface PiContinuityPolicy {
  intentRef: string;
  originalEvidence: unknown;
  requiredReadPaths: readonly string[];
  inspect(input: PiContinuityInspection, signal: AbortSignal): Promise<{
    status: 'fresh' | 'stale' | 'unavailable';
    scope: 'complete' | 'unknown';
  }>;
}

const REFUSED = 'Source continuity is stale, incomplete or unavailable';

/** In-memory per-session observations, not a receipt, persisted store or lease. */
export function createPiContinuityGuard(workspace: string, policy: PiContinuityPolicy) {
  const { intentRef, inspect } = policy;
  // Keep the initial evidence forever; later observations only append. Copies
  // sent to the adapter cannot rewrite the stored initial evidence or reads.
  // V8 serialization copies view bytes and rejects raw shared backing memory,
  // instead of structuredClone's SharedArrayBuffer aliasing. Nothing is saved.
  let originalEvidence: Buffer;
  try { originalEvidence = serialize(policy.originalEvidence); } catch { throw new Error(REFUSED); }
  const paths = policy.requiredReadPaths;
  if (typeof intentRef !== 'string' || !intentRef.trim() || typeof inspect !== 'function'
    || !Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== 'string'
      || !path || isAbsolute(path) || relative(workspace, resolve(workspace, path)) !== path
      || path.split(/[\\/]/).some(part => part === '..'))) throw new Error(REFUSED);
  const required = new Set(paths);
  const reads: PiSourceRead[] = [];
  return {
    observeRead(root: string, path: string, bytes: Buffer, signal: AbortSignal) {
      signal.throwIfAborted();
      if (root !== workspace || !required.has(path)) return;
      // A UTF-8 replacement character must not certify bytes the model did not
      // actually see. Oversized/partial/failed reads never reach this callback.
      if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) return;
      reads.push({ workspace, path, bytes: Uint8Array.from(bytes) });
    },
    async assertCurrent(root: string, action: PiContinuityAction, signal: AbortSignal) {
      signal.throwIfAborted();
      if (root !== workspace) throw new Error(REFUSED);
      let result;
      let onAbort!: () => void;
      const stopped = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('Stopped'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        result = await Promise.race([stopped, Promise.resolve().then(() => {
          signal.throwIfAborted();
          return inspect({ workspace, intentRef, action: structuredClone(action),
            // Deserialized typed arrays can alias the serialized Buffer. Clone
            // once more so in-place adapter edits cannot alter that snapshot.
            originalEvidence: structuredClone(deserialize(originalEvidence)), reads: structuredClone(reads) }, signal);
        })]);
      } catch {
        signal.throwIfAborted();
        throw new Error(REFUSED);
      } finally { signal.removeEventListener('abort', onAbort); }
      signal.throwIfAborted();
      if (result?.status !== 'fresh' || result?.scope !== 'complete') throw new Error(REFUSED);
    },
  };
}

export type PiContinuityGuard = ReturnType<typeof createPiContinuityGuard>;
