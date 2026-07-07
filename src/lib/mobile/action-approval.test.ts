import { describe, expect, it } from 'vitest';
import { selectMobileReviewApprovalId } from '@/lib/mobile/action-approval';

describe('selectMobileReviewApprovalId', () => {
  it('uses explicit approval authority when provided', () => {
    expect(selectMobileReviewApprovalId(' approval-1 ', [])).toBe('approval-1');
  });

  it('fails closed without exactly one pending approval for the session', () => {
    expect(selectMobileReviewApprovalId(undefined, [])).toBe('');
    expect(selectMobileReviewApprovalId(undefined, [{ id: 'approval-1' }, { id: 'approval-2' }])).toBe('');
  });

  it('allows the single pending approval fallback for backward compatibility', () => {
    expect(selectMobileReviewApprovalId(undefined, [{ id: 'approval-1' }])).toBe('approval-1');
  });
});
