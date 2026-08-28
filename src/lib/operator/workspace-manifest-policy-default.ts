import 'server-only';

import {
  envWorkspaceManifestPolicy,
  isWorkspaceManifestPolicy,
  type WorkspaceManifestPolicy,
} from './defaults-env';

export interface WorkspaceManifestPolicyDefault {
  workspaceManifestPolicy: WorkspaceManifestPolicy;
}

export const WORKSPACE_MANIFEST_POLICY_FALLBACK: WorkspaceManifestPolicyDefault = {
  workspaceManifestPolicy: 'disabled',
};

export function resolveStoredWorkspaceManifestPolicy(
  stored: Partial<WorkspaceManifestPolicyDefault>,
): Partial<WorkspaceManifestPolicyDefault> {
  return isWorkspaceManifestPolicy(stored.workspaceManifestPolicy)
    ? { workspaceManifestPolicy: stored.workspaceManifestPolicy }
    : {};
}

export function resolveWorkspaceManifestPolicySettings(
  file: Partial<WorkspaceManifestPolicyDefault>,
) {
  const envPolicy = envWorkspaceManifestPolicy();
  return {
    values: {
      workspaceManifestPolicy:
        envPolicy ?? file.workspaceManifestPolicy ?? WORKSPACE_MANIFEST_POLICY_FALLBACK.workspaceManifestPolicy,
    },
    sources: {
      workspaceManifestPolicy:
        envPolicy !== null ? 'env' as const : file.workspaceManifestPolicy !== undefined ? 'file' as const : 'default' as const,
    },
  };
}

export function applyWorkspaceManifestPolicyUpdate(
  stored: Partial<WorkspaceManifestPolicyDefault>,
  update: Partial<WorkspaceManifestPolicyDefault>,
): void {
  if (update.workspaceManifestPolicy === undefined) return;
  if (!isWorkspaceManifestPolicy(update.workspaceManifestPolicy)) {
    throw new Error('workspaceManifestPolicy must be one of "disabled", "one-approval", "auto".');
  }
  stored.workspaceManifestPolicy = update.workspaceManifestPolicy;
}
