import { listRepos } from '@/lib/repos/registry';
import { WorktreeManager } from '@/lib/worktree/manager';
import {
  reconcileDependencyMaterializations,
  type DependencyMaterializationReceipt,
  type DependencyMaterializationWorkspaceAuthority,
  type DependencyMaterializationReconciliationReceipt,
} from './dependency-materializer';
import {
  reconcileDependencyImagePublications,
  type DependencyImagePublicationRecoveryReceipt,
} from './dependency-image-publication-recovery';

export interface DependencyImageStartupReconciliationReceipt {
  publications: DependencyImagePublicationRecoveryReceipt;
  materializations: DependencyMaterializationReconciliationReceipt;
  complete: boolean;
}

/** Production startup order for publication, lease, and then workspace recovery. */
export async function reconcileDependencyImagesAtStartup(): Promise<
  DependencyImageStartupReconciliationReceipt
> {
  const publications = await reconcileDependencyImagePublications();
  const authorities: DependencyMaterializationWorkspaceAuthority[] = [];
  for (const repo of await listRepos()) {
    const manager = new WorktreeManager(repo.localPath);
    const receipts = await manager.listDependencyMaterializationAuthorities();
    authorities.push(...receipts.map((authority) => ({
      workspacePath: authority.workspacePath,
      receipt: authority.receipt,
      promoteMounted: (receipt: DependencyMaterializationReceipt) => (
        manager.recordDependencyMaterialization(authority.worktreeId, receipt)
      ),
      markUnavailable: (receipt: DependencyMaterializationReceipt | null) => (
        manager.markDependencyMaterializationUnavailable(authority.worktreeId, receipt)
      ),
    })));
  }
  const materializations = await reconcileDependencyMaterializations(authorities);
  return {
    publications,
    materializations,
    complete: publications.complete && materializations.complete,
  };
}
