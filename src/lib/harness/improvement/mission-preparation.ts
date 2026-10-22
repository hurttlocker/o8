import 'server-only';
import { requireImprovementNamespace } from './namespace';
import { bindImprovementMissionCapability, deriveImprovementMissionDraft } from './mission-capability';
import { createImprovementJournal } from './journal';
import { join } from 'node:path';
import { object, text } from './validation';

/**
 * Source-only first-packet preparation. Invoke only in the initializer's dedicated child process.
 * A namespace is single-use: existing or partial missions require explicit reconciliation, not reset.
 * Supporting every execution stage later requires reviewed stage namespaces or owned-mission reuse.
 * Neither the namespace marker nor this preparation grants permission to dispatch.
 */
export async function prepareImprovementMission(input: { experimentId: string; requestId: string }) {
  object(input, ['experimentId', 'requestId']); text(input.experimentId, 128); text(input.requestId, 128);
  const namespace = requireImprovementNamespace();
  if (namespace.experimentId !== input.experimentId) throw new Error('Refinement namespace experiment differs.');
  const state = createImprovementJournal(join(namespace.root, 'harness-refinement')).read(input.experimentId);
  if (!state?.pending || state.pending.id !== input.requestId) throw new Error('Exact persisted pending request is required.');
  const draft = await deriveImprovementMissionDraft(namespace);
  const { prepareImprovementPacketBinding } = await import('./launch-guard');
  const binding = prepareImprovementPacketBinding({ ...input, mountDigest: draft.mountDigest });
  const missionInput = await bindImprovementMissionCapability(namespace, binding, draft);
  // No ordinary mission/DB import occurs before dedicated namespace proof and captured DB-path checks.
  try {
    const { createMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
    const receipt = await createMission(missionInput);
    return { status: 'held' as const, reason: 'trusted_launch_grant_and_verified_isolated_carrier_required',
      namespaceId: namespace.id, packetId: binding.packetId, mountDigest: binding.mountDigest, receipt };
  } catch (error) {
    throw new Error('Refinement mission preparation outcome requires reconciliation; do not create or dispatch another packet.', { cause: error });
  }
}
