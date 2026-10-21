import { inspectionKey, VISUAL_INSPECTION_BUDGET_MS, type VisualInspectionInput, type VisualInspectionResult } from './visual-inspection';
import type { VisualInstructionTarget } from './visual-instruction';

const jobs = new Map<string, { key: string; abort: AbortController; result?: VisualInspectionResult }>();
const listeners = new Set<() => void>();
const scope = (input: Pick<VisualInspectionInput, 'principal' | 'requestId'>) => JSON.stringify([input.principal, input.requestId]);
export const subscribeVisualInspections = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const publish = () => listeners.forEach(listener => listener());
export function readVisualInspection(input: VisualInspectionInput): VisualInspectionResult | null {
  const job = jobs.get(scope(input));
  return job?.key === inspectionKey(input) ? job.result ?? null : null;
}
export function invalidateVisualInspection(principal: string, requestId: string) {
  const id = scope({ principal, requestId }); jobs.get(id)?.abort.abort(); jobs.delete(id); publish();
}

/** One cancellable advisory batch. No caller needs to await this before typing or sending. */
export function inspectVisualDraft(input: VisualInspectionInput, target: VisualInstructionTarget, transport: typeof fetch = fetch, readyAt = Date.now()) {
  const id = scope(input); const key = inspectionKey(input);
  if (jobs.get(id)?.key === key) return;
  jobs.get(id)?.abort.abort();
  const abort = new AbortController(); const job = { key, abort, result: undefined as VisualInspectionResult | undefined };
  jobs.set(id, job);
  // Bound cached results and never retain image bytes in the store.
  if (jobs.size > 32) { const oldest = jobs.keys().next().value!; jobs.get(oldest)?.abort.abort(); jobs.delete(oldest); }
  const remaining = Math.max(0, readyAt + VISUAL_INSPECTION_BUDGET_MS - Date.now());
  if (!remaining) return;
  const deadline = performance.now() + remaining;
  const timer = setTimeout(() => abort.abort(), remaining);
  void (async () => {
    try {
      // Coalesce independent typing events inside the same end-to-end budget.
      await new Promise<void>(resolve => { const delay = setTimeout(resolve, 180); abort.signal.addEventListener('abort', () => { clearTimeout(delay); resolve(); }, { once: true }); });
      if (abort.signal.aborted) return;
      const remainingMs = Math.floor(deadline - performance.now());
      if (remainingMs < 1) return;
      const response = await transport('/api/orchestrator/visual-inspection', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: abort.signal, body: JSON.stringify({ ...input, target, key, remainingMs }) });
      const raw: unknown = await response.json();
      if (!response.ok || !raw || typeof raw !== 'object' || !('key' in raw) || raw.key !== key
        || !('status' in raw) || !['observed', 'unavailable'].includes(String(raw.status))) return;
      if (!abort.signal.aborted && performance.now() <= deadline && jobs.get(id) === job) {
        job.result = raw as VisualInspectionResult; publish();
      }
    } catch { /* The usable visual draft remains independent of inspection. */ }
    finally { clearTimeout(timer); }
  })();
}
