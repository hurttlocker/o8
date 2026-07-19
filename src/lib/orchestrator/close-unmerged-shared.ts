/**
 * Client-safe close-unmerged vocabulary (#1570).
 *
 * Extracted from close-unmerged.ts so that CLIENT components (the
 * PacketCloseUnmergedActions card strip) can import the disposition list,
 * labels, and types WITHOUT pulling in the server-only close pipeline
 * (`close-unmerged.ts` imports node:child_process + the lane/orchestrator
 * backends, which transitively import `server-only` — that leaks into the
 * client bundle and fails `next build`, #1570 build regression). Pure data +
 * pure functions only; no runtime imports.
 */

/**
 * Explicit operator dispositions for work that is intentionally not merged.
 * Shared by the control plane and every operator surface so a close is
 * recorded consistently instead of inheriting a stop or failure label.
 */
export const CLOSE_UNMERGED_DISPOSITIONS = [
  'adopted_elsewhere',
  'superseded',
  'spec_changed',
  'wontfix',
] as const;

export type CloseUnmergedDisposition = typeof CLOSE_UNMERGED_DISPOSITIONS[number];

export type CloseUnmergedResult =
  | {
    ok: true;
    result: {
      closed: true;
      discarded: true;
      disposition: CloseUnmergedDisposition;
      laneId: string;
      packetId: string;
      worktreeRemoved: boolean;
      preservedBranch: string | null;
      note: string;
    };
  }
  | {
    ok: false;
    code: string;
    message: string;
    status: 400 | 404 | 409 | 422 | 500;
    error?: unknown;
  };

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
