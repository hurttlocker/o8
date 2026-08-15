/** Enforce recommended order only between packets whose worktrees overlap. */
export function selectMergeSequence<
  T extends { worktree: { id: string }; overlappingWorktreeIds: Set<string> },
>(ordered: T[], targetIndex: number): T[] {
  const target = ordered[targetIndex];
  if (!target) return [];
  return [
    ...ordered.slice(0, targetIndex).filter((candidate) =>
      target.overlappingWorktreeIds.has(candidate.worktree.id)),
    target,
  ];
}
