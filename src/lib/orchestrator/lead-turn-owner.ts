import {
  isMetadataLockProcessIdentity,
  probeMetadataLockProcessIdentitySync,
  sameMetadataLockProcessIdentity,
} from '@/lib/worktree/metadata-lock-process-identity';
import { LeadLifecycleError, type TurnRow } from '@/lib/orchestrator/lead-contract';

export function currentLeadOwnerIdentityJson(): string {
  const probe = probeMetadataLockProcessIdentitySync(process.pid);
  if (probe.state !== 'live') {
    throw new LeadLifecycleError(
      'The lead runtime could not establish its process identity.',
      'lead_owner_identity_unavailable',
      503,
    );
  }
  return JSON.stringify(probe.identity);
}

export function leadTurnOwnerState(turn: TurnRow): 'alive' | 'dead' | 'unknown' {
  if (!turn.owner_pid || !turn.owner_identity_json) return 'unknown';
  const probe = probeMetadataLockProcessIdentitySync(turn.owner_pid);
  if (probe.state === 'absent') return 'dead';
  if (probe.state !== 'live') return 'unknown';
  try {
    const recorded = JSON.parse(turn.owner_identity_json) as unknown;
    if (!isMetadataLockProcessIdentity(recorded)) return 'unknown';
    return sameMetadataLockProcessIdentity(probe.identity, recorded) ? 'alive' : 'dead';
  } catch {
    return 'unknown';
  }
}
