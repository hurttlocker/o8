import type { ApprovalRisk } from '@/lib/approvals/types';

function isDocumentationPath(path: string): boolean {
  return path.startsWith('docs/') || path.toLowerCase().endsWith('.md');
}

/**
 * Risk for a merge-mechanics approval (base moved, rebase conflict): a diff
 * that touches only documentation rates low; anything else, or an unknown
 * diff, keeps the failure category's risk.
 */
export function riskForChangedPaths(
  files: ReadonlyArray<{ path: string }>,
  fallbackRisk: ApprovalRisk,
): ApprovalRisk {
  if (files.length === 0) return fallbackRisk;
  return files.every((file) => isDocumentationPath(file.path)) ? 'low' : fallbackRisk;
}
