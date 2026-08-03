export const GOVERNED_EXISTING_BRANCH_POLICY = 'reset' as const;

export function governedMissionCreateArgs(input: {
  title: string;
  body: string;
  repoRoot: string;
  issue: number;
}): string[] {
  return [
    'mission', 'create',
    '--title', input.title,
    '--body', input.body,
    '--repo', input.repoRoot,
    '--number', String(input.issue),
    '--existingBranchPolicy', GOVERNED_EXISTING_BRANCH_POLICY,
  ];
}
