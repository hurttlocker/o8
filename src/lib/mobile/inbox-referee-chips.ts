/**
 * Referee chips on phone inbox cards (#2439, tracker #2445). ADVISORY ONLY.
 *
 * The desktop reads the merge-card referee facts already stored on an approval
 * (#2435) and attaches a chip when a calibrated fact clears its threshold. The
 * phone never calls the referee. Nothing decides on a chip: a card with chips
 * approves through the same `/api/panel/approvals` call as every other card,
 * adding only `via: 'chip'`, which records that the chips were shown.
 *
 * One chip is calibrated today: "Docs only". It needs BOTH o8's own
 * path-derived docsOnly (the rule in `judgment/diff-state.ts`, over the same
 * file list and diff text the referee read) AND the referee's answer at or
 * above `DOCS_ONLY_CHIP_THRESHOLD`, not abstaining. With the setting off, no
 * stored facts, or nothing above threshold, the item is returned untouched.
 */
import { getApproval } from '@/lib/approvals/store';
import type { ApprovalAuditEvent, ApprovalRecord } from '@/lib/approvals/types';
import { thresholdAnswer } from '@/lib/judgment/client';
import { buildDiffState } from '@/lib/judgment/diff-state';
import { DOCS_ONLY_CHIP_THRESHOLD } from '@/lib/judgment/questions';
import { isInboxUrgencyEnabled } from '@/lib/mobile/inbox-urgency';
import type { MobileInboxRefereeChip, MobileInboxSnapshot } from '@/lib/mobile/types';

/** o8's path-derived docsOnly over the approval's diff, by the same rule the referee state uses. */
function pathDocsOnly(approval: ApprovalRecord): boolean {
  const files = (approval.diff?.files ?? []).map((file) => ({ path: file.path }));
  const diffText = approval.diff?.after ?? '';
  if (files.length === 0 && !diffText.trim()) return false;
  return buildDiffState(files, diffText).state.docsOnly;
}

/** The chips an approval earns from its stored referee facts. Empty when the setting is off. */
export function refereeChipsForApproval(approval: ApprovalRecord | null): MobileInboxRefereeChip[] {
  const referee = approval?.referee;
  if (!approval || !referee || !isInboxUrgencyEnabled()) return [];
  const docsOnly = thresholdAnswer(referee.answers.docsOnly);
  if (!docsOnly || docsOnly.noul < DOCS_ONLY_CHIP_THRESHOLD) return [];
  if (!pathDocsOnly(approval)) return [];
  return [{ kind: 'docs-only', probability: docsOnly.noul, receiptId: referee.receiptId }];
}

/** Attach chips to approval items that earn them; every other item keeps its exact bytes. */
export function applyInboxRefereeChips(snapshot: MobileInboxSnapshot): MobileInboxSnapshot {
  if (!isInboxUrgencyEnabled() || snapshot.items.length === 0) return snapshot;
  try {
    let changed = false;
    const items = snapshot.items.map((item) => {
      if (item.kind !== 'approval' || !item.approvalId) return item;
      const refereeChips = refereeChipsForApproval(getApproval(item.approvalId));
      if (refereeChips.length === 0) return item;
      changed = true;
      return { ...item, refereeChips };
    });
    return changed ? { ...snapshot, items } : snapshot;
  } catch (error) {
    console.warn('[mobile-inbox-chips] chips skipped:', error instanceof Error ? error.message : 'error');
    return snapshot;
  }
}

/**
 * The fact recorded on the approval event when the phone approves from a card
 * that showed chips. Unknown `via` values are ignored. The chip kinds are
 * recomputed here, never taken from the request.
 */
export function approvedFromCardFact(
  via: unknown,
  approval: ApprovalRecord,
): ApprovalAuditEvent['approvedFromCard'] {
  if (via !== 'chip') return undefined;
  return { via: 'chip', chipsShown: refereeChipsForApproval(approval).map((chip) => chip.kind) };
}
