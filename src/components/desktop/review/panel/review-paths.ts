export function reviewPathCandidates(reviewPath: string) {
  const parts = reviewPath.includes(' → ') ? reviewPath.split(' → ') : [reviewPath];
  return [reviewPath, ...parts].filter(Boolean);
}

export function reviewRowPathForSourcePath(sourcePath: string, reviewPaths: string[]) {
  return reviewPaths.find((reviewPath) => reviewPathCandidates(reviewPath).includes(sourcePath)) ?? null;
}
