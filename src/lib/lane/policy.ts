import type { LanePolicy } from './types';

const PROTECTED_BRANCHES = new Set(['main', 'master', 'production', 'release']);

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
