import type { RepoRegistryEntry } from '@/lib/repos/types';

export type SetupRequestStatus = 'pending' | 'applying' | 'interrupted' | 'needs_tools' | 'needs_privacy' | 'opened' | 'error' | 'cancelled';
export interface AgentSetupRequest {
  id: string;
  project: Pick<RepoRegistryEntry, 'id' | 'name' | 'localPath' | 'defaultBranch'>;
  status: SetupRequestStatus;
  updatedAt: string;
  error?: string;
  claimId?: string;
  leaseExpiresAt?: string;
}
