export function selectMobileReviewApprovalId(
  explicitApprovalId: string | undefined,
  pendingForSession: Array<{ id: string }>,
) {
  const explicit = explicitApprovalId?.trim();
  if (explicit) return explicit;
  return pendingForSession.length === 1 ? pendingForSession[0]?.id ?? '' : '';
}
