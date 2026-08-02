export interface RepositoryPolicy {
  repositoryId: string;
  requiredApprovals: number;
}

const policies = new Map<string, RepositoryPolicy>();

export async function loadPolicy(repositoryId: string): Promise<RepositoryPolicy | null> {
  return policies.get(repositoryId) ?? null;
}

export async function savePolicy(policy: RepositoryPolicy): Promise<void> {
  policies.set(policy.repositoryId, policy);
}
