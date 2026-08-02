export interface RepositoryProjection {
  repositoryId: string;
  openReviews: number;
}

const projectionsByRepository = new Map<string, RepositoryProjection>();

export function writeProjection(projection: RepositoryProjection): void {
  projectionsByRepository.set(projection.repositoryId, projection);
}

export function readProjection(repositoryId: string): RepositoryProjection | null {
  return projectionsByRepository.get(repositoryId) ?? null;
}
