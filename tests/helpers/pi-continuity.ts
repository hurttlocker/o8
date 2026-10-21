import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PiContinuityInspection, PiContinuityPolicy } from '@/lib/pi/sdk/continuity';

export const CONTINUITY_COMMAND = 'printf ran > sentinel.txt';

/**
 * Synthetic byte-backed adapter, not the production handoff validator. Each
 * decision reads the real fixture files again. Only the two exact test actions
 * have known scope. A future production adapter must use its existing source
 * evidence checker rather than treating this fixture format as a new receipt.
 */
export async function byteContinuityPolicy(workspace: string, paths = ['source.txt']) {
  const original: Record<string, Uint8Array> = {};
  for (const path of paths) original[path] = Uint8Array.from(await readFile(join(workspace, path)));
  const inspections: PiContinuityInspection[] = [];
  const policy: PiContinuityPolicy = {
    intentRef: 'opaque-authorized-intent', originalEvidence: original, requiredReadPaths: paths,
    async inspect(input) {
      inspections.push(structuredClone(input));
      const complete = input.workspace === workspace && (input.action.name === 'write_file'
        ? input.action.path === 'result.txt' : input.action.command === CONTINUITY_COMMAND);
      if (!complete) return { status: 'unavailable', scope: 'unknown' };
      const evidence = input.originalEvidence as Record<string, unknown> | null;
      if (!evidence || paths.some(path => !(evidence[path] instanceof Uint8Array))) {
        return { status: 'unavailable', scope: 'complete' };
      }
      try {
        for (const path of paths) {
          const current = await readFile(join(workspace, path));
          const latest = input.reads.findLast(read => read.workspace === workspace && read.path === path);
          const observed = latest?.bytes ?? evidence[path] as Uint8Array;
          if (!current.equals(observed)) return { status: 'stale', scope: 'complete' };
        }
        return { status: 'fresh', scope: 'complete' };
      } catch { return { status: 'unavailable', scope: 'complete' }; }
    },
  };
  return { policy, inspections, original };
}
