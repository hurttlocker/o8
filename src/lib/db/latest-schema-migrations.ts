import type Database from 'better-sqlite3';
import { ensureV36HarnessSchema } from '@/lib/db/v36-harness-migration';
import { ensureV37WorkspaceSnapshotSchema } from '@/lib/db/v37-workspace-snapshot-migration';
import { ensureV38StorageAdmissionSchema } from '@/lib/db/v38-storage-admission-migration';
import { ensureV39WorkspaceLifecycleLeaseSchema } from '@/lib/db/v39-workspace-lifecycle-lease-migration';
import { ensureV40StorageRootIdentitySchema } from '@/lib/db/v40-storage-root-identity-migration';
import { ensureV41WorkspaceRetirementSchema } from '@/lib/db/v41-workspace-retirement-migration';
import { ensureV42WorkspaceRestoreClaimSchema } from '@/lib/db/v42-workspace-restore-claim-migration';
import { ensureV43ResourceLeaseSchema } from '@/lib/db/v43-resource-leases-migration';
import { ensureV44BroadcastSchema } from '@/lib/db/v44-broadcast-migration';
import { ensureV45BroadcastFocusSchema } from '@/lib/db/v45-broadcast-focus-migration';

/**
 * Keep the current additive migrations behind one boot hook. `db/index.ts` is
 * at its governed file ceiling, while these helpers must still run on every
 * connection so concurrent app processes can upgrade safely.
 */
export function ensureLatestSchemas(sqlite: Database.Database): void {
  ensureV36HarnessSchema(sqlite);
  ensureV37WorkspaceSnapshotSchema(sqlite);
  ensureV38StorageAdmissionSchema(sqlite);
  ensureV39WorkspaceLifecycleLeaseSchema(sqlite);
  ensureV40StorageRootIdentitySchema(sqlite);
  ensureV41WorkspaceRetirementSchema(sqlite);
  ensureV42WorkspaceRestoreClaimSchema(sqlite);
  ensureV43ResourceLeaseSchema(sqlite);
  ensureV44BroadcastSchema(sqlite);
  ensureV45BroadcastFocusSchema(sqlite);
}
