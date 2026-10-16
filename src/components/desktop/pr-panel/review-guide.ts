import type { PrDetail, PrTabId } from './types';

export interface PrReviewStep { id: string; title: string; note: string; tab: PrTabId; file?: string }
export interface PrReviewGuide { head: string; base: string; steps: PrReviewStep[] }
export function buildPrReviewGuide(detail: PrDetail): PrReviewGuide | null {
  if (!detail.headSha || !/^[a-f0-9]{40,64}$/i.test(detail.headSha)) return null;
  const priority = (path: string) => /(^|\/)(auth|security|permissions|billing|migrations|runtime|runtimes)(\/|\.)|package(?:-lock)?\.json|Cargo\.lock/i.test(path) ? 2 : /(^|\/)(tests?|__tests__)(\/|\.)|\.(?:test|spec)\./i.test(path) ? 0 : 1;
  const files = [...detail.files].sort((a, b) => priority(b.path) - priority(a.path) || b.additions + b.deletions - a.additions - a.deletions || a.path.localeCompare(b.path));
  const failures = detail.statusCheckRollup.filter(check => /^(failure|timed_out|cancelled|action_required)$/i.test(check.conclusion ?? '')).length;
  const running = detail.statusCheckRollup.filter(check => !check.conclusion && check.status !== 'completed').length;
  const steps: PrReviewStep[] = [{ id: 'intent', title: 'Understand the change', note: detail.body.trim() ? 'Read the description and compare the intended behavior with the diff.' : 'This pull request has no description. Confirm its intended behavior before approving.', tab: 'summary' }];
  for (const file of files.slice(0, 10)) steps.push({ id: `file:${file.path}`, title: file.path, file: file.path, tab: 'changes', note: file.patch === null ? 'A text diff is unavailable. Inspect the file or media in the changes view, and use GitHub for anything omitted.' : priority(file.path) === 2 ? 'Check permissions, compatibility and failure handling here.' : 'Compare the changed behavior with its tests and callers.' });
  if (detail.changedFiles > files.slice(0, 10).length) steps.push({ id: 'remaining-files', title: 'Review the remaining files', note: `${detail.changedFiles - files.slice(0, 10).length} more changed files. This guide lists a starting order, not a complete review.`, tab: 'changes' });
  if (!detail.changedFiles) steps.push({ id: 'no-files', title: 'Confirm the change scope', note: 'No changed files were reported. Confirm the source and branch before reviewing.', tab: 'changes' });
  steps.push({ id: 'checks', title: 'Verify checks and behavior', note: detail.checksUnavailable ? 'Checks could not be read. Verify them on GitHub and exercise the affected behavior.' : failures ? `${failures} failing check${failures === 1 ? '' : 's'}. Inspect the failures before deciding.` : running ? `${running} check${running === 1 ? '' : 's'} still running. Recheck their results before approving.` : detail.statusCheckRollup.length ? 'Reported checks finished. Exercise the relevant behavior; CI does not replace your review.' : 'No checks were reported. Confirm the applicable tests and manual acceptance.', tab: 'checks' });
  steps.push({ id: 'discussion', title: 'Resolve review feedback', note: detail.discussionIncomplete ? 'Some discussion is omitted here. Read the full thread on GitHub before deciding.' : 'Check unresolved questions and requested changes. Use review chat when you need help.', tab: 'reviews' });
  return { head: detail.headSha, base: detail.baseSha ?? '', steps };
}

export interface PrGuideProgress { head: string; base: string; done: string[] }
const memory = new Map<string, PrGuideProgress>();
const storageKey = (selection: string) => `o8:pr-review-guide:${encodeURIComponent(selection)}`;
export function readPrGuideProgress(selection: string): PrGuideProgress | null {
  if (memory.has(selection)) return memory.get(selection)!;
  try {
    const raw = localStorage.getItem(storageKey(selection)); if (!raw || raw.length > 64 * 1024) return null;
    const value = JSON.parse(raw) as PrGuideProgress;
    if (!/^[a-f0-9]{40,64}$/i.test(value.head) || typeof value.base !== 'string' || !Array.isArray(value.done) || value.done.length > 64 || !value.done.every(id => typeof id === 'string' && id.length <= 4096)) return null;
    return value;
  } catch { return null; }
}
export function savePrGuideProgress(selection: string, progress: PrGuideProgress): void {
  if (memory.size >= 80 && !memory.has(selection)) memory.delete(memory.keys().next().value!);
  memory.set(selection, progress);
  try { localStorage.setItem(storageKey(selection), JSON.stringify(progress)); } catch { /* Progress still survives panel close/reopen in this session. */ }
}
