export interface ReviewRequest {
  actorId: string;
  repositoryOwnerId: string;
  approved: boolean;
}

export function canPublishReview(request: ReviewRequest): boolean {
  return request.approved;
}

export function publishReview(request: ReviewRequest): string {
  if (!canPublishReview(request)) {
    throw new Error('review must be approved before publication');
  }
  return `published:${request.actorId}`;
}
