import { getSqlite } from '@/lib/db';

const cancelledClaims = new Set<string>();

function cancellationKey(reviewId: string, claimOwner?: string | null): string {
  return claimOwner ? `${reviewId}\u0000${claimOwner}` : reviewId;
}

function deleteReviewClaims(reviewId: string): void {
  cancelledClaims.delete(reviewId);
  const prefix = `${reviewId}\u0000`;
  for (const key of cancelledClaims) {
    if (key.startsWith(prefix)) cancelledClaims.delete(key);
  }
}

export const reviewCancellationRegistry = {
  add(reviewId: string): void {
    const db = getSqlite();
    const row = db.prepare(
      `SELECT claim_owner FROM review_queue WHERE id = ? AND status = 'in_progress'`,
    ).get(reviewId) as { claim_owner: string | null } | undefined;
    cancelledClaims.add(cancellationKey(reviewId, row?.claim_owner));
    db.prepare(
      `UPDATE review_queue SET claimed_at = NULL, claim_owner = NULL
       WHERE id = ? AND status = 'in_progress'`,
    ).run(reviewId);
  },
  has(reviewId: string, claimOwner?: string | null): boolean {
    if (claimOwner) {
      return cancelledClaims.has(cancellationKey(reviewId, claimOwner))
        || cancelledClaims.has(reviewId);
    }
    if (cancelledClaims.has(reviewId)) return true;
    const prefix = `${reviewId}\u0000`;
    return [...cancelledClaims].some((key) => key.startsWith(prefix));
  },
  delete(reviewId: string, claimOwner?: string | null): void {
    if (claimOwner) {
      cancelledClaims.delete(cancellationKey(reviewId, claimOwner));
      return;
    }
    deleteReviewClaims(reviewId);
  },
};

/** Cancel one claim generation without touching the lane's successor rows. */
export function cancelReviewAttempt(reviewId: string, claimOwner?: string | null): void {
  cancelledClaims.add(cancellationKey(reviewId, claimOwner));
}
