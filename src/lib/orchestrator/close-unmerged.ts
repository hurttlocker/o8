/**
 * Explicit operator dispositions for work that is intentionally not merged.
 * These are shared by the control plane and every operator surface so a close
 * is recorded consistently instead of inheriting a stop or failure label.
 */
export const CLOSE_UNMERGED_DISPOSITIONS = [
  'adopted_elsewhere',
  'superseded',
  'spec_changed',
  'wontfix',
] as const;

export type CloseUnmergedDisposition = typeof CLOSE_UNMERGED_DISPOSITIONS[number];

const DISPOSITION_LABELS: Record<CloseUnmergedDisposition, string> = {
  adopted_elsewhere: 'Adopted elsewhere',
  superseded: 'Superseded',
  spec_changed: 'Spec changed',
  wontfix: "Won't fix",
};

export function isCloseUnmergedDisposition(value: unknown): value is CloseUnmergedDisposition {
  return typeof value === 'string'
    && (CLOSE_UNMERGED_DISPOSITIONS as readonly string[]).includes(value);
}

export function closeUnmergedDispositionLabel(disposition: CloseUnmergedDisposition): string {
  return DISPOSITION_LABELS[disposition];
}

export function closeUnmergedOutcomeNote(input: {
  disposition: CloseUnmergedDisposition;
  note?: string | null;
  preservedBranch?: string | null;
}): string {
  const details = input.note?.trim();
  const preserved = input.preservedBranch
    ? ` Work preserved on branch ${input.preservedBranch}.`
    : '';
  return `Closed unmerged — ${closeUnmergedDispositionLabel(input.disposition)}.${preserved}${details ? ` ${details}` : ''}`;
}
