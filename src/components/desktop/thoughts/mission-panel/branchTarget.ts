export interface PacketBranchInfo {
  name: string;
  current: boolean;
  lastCommitAge: string;
  lastCommitMessage: string;
  lastCommitUnix?: number;
  isWorktree: boolean;
}

export const PACKET_BRANCH_REQUIRED_REASON = 'Select a target branch before launching.';

export function hasPacketBranchTarget(branchTarget: string | null | undefined) {
  return Boolean(branchTarget?.trim());
}

export function clearPacketBranchBlockedReason(blockedReason: string | null | undefined) {
  return blockedReason === PACKET_BRANCH_REQUIRED_REASON ? null : blockedReason ?? null;
}

export function sortPacketBranches(branches: PacketBranchInfo[]) {
  return [...branches].sort((left, right) => (
    (right.lastCommitUnix ?? 0) - (left.lastCommitUnix ?? 0)
    || Number(right.current) - Number(left.current)
    || left.name.localeCompare(right.name)
  ));
}

export function findCurrentPacketBranch(branches: PacketBranchInfo[]) {
  return branches.find((branch) => branch.current) ?? null;
}

export async function fetchPacketBranches(workspaceTargetPath: string) {
  const response = await fetch(`/api/panel/branches?path=${encodeURIComponent(workspaceTargetPath)}`);
  const payload = await response.json().catch(() => null) as {
    branches?: PacketBranchInfo[];
    error?: string;
  } | null;

  if (!response.ok) {
    throw new Error(payload?.error ?? 'Unable to load branches.');
  }

  return sortPacketBranches(payload?.branches ?? []);
}
