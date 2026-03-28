import type { LanePolicy } from './types';

const PROTECTED_BRANCHES = new Set(['main', 'master', 'production', 'release']);

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for base-branch-specific policy
export function getLanePolicy(branch: string, _baseBranch?: string): LanePolicy {
  const isProtected = PROTECTED_BRANCHES.has(branch);
  return {
    branchWritable: !isProtected,
    requiresApproval: isProtected,
    autoSpawnAllowed: !isProtected,
  };
}

export function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.has(branch);
}
