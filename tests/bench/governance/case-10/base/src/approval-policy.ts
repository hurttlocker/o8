export interface ApprovalRequest {
  actorId: string;
  reviewState: 'open' | 'closed';
  repository: {
    ownerId: string;
    approverIds: string[];
  };
}

export function canApprove(request: ApprovalRequest): boolean {
  return request.reviewState === 'open';
}
