export interface PublishRequest {
  actorId: string;
  repositoryOwnerId: string;
  approved: boolean;
}

export function publishApprovedReview(request: PublishRequest): string {
  if (!request.approved) {
    throw new Error('review must be approved before publication');
  }
  return `published:${request.actorId}`;
}
