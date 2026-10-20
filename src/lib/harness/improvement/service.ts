import 'server-only';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { getContract } from '@/lib/harness/store';
import type { HarnessServiceContext } from '@/lib/harness/service';
import { advanceExperiment, createExperiment, revokeExperimentLesson } from './engine';
import { createImprovementJournal } from './journal';
import { improvementAccounting } from './accounting';
import { digest, integer, manifest as validateManifest, object, text } from './validation';

/** Operator-only preparation is deliberately NOT launch authorization. */
export async function handleImprovementAction(body: Record<string, unknown>, context: HarnessServiceContext, repository: string): Promise<unknown> {
  if (context.actor !== 'operator') throw new Error('Refinement requires operator authority.');
  const journal = createImprovementJournal(join(getDataDir(), 'harness-refinement'));
  if (body.action === 'refinement_prepare') {
    object(body, ['action', 'repoPath', 'contractId', 'manifest']);
    text(body.contractId, 128); validateManifest(body.manifest);
    const contract = getContract(body.contractId);
    if (!contract || contract.repoPath !== repository || contract.status !== 'accepted') {
      throw new Error('Refinement requires an accepted contract in the exact repository.');
    }
    if (body.manifest.repository !== repository || body.manifest.contractDigest !== digest(contract)) {
      throw new Error('Refinement contract binding differs from the accepted contract.');
    }
    const head = execFileSync('git', ['-C', repository, 'rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
    }).trim();
    if (head !== body.manifest.baselineRevision) throw new Error('Repository HEAD differs from the frozen baseline.');
    const state = journal.append(createExperiment(body.manifest), null);
    return { state, launch: 'held', reason: 'Separate exact-contract launch authorization and verified isolated carrier required.' };
  }
  if (body.action === 'refinement_status') {
    object(body, ['action', 'repoPath', 'id']); text(body.id, 128);
    const state = journal.read(body.id);
    if (!state || state.manifest.repository !== repository) throw new Error('Refinement experiment not found in repository.');
    return { state, accounting: improvementAccounting(state), launch: 'held' };
  }
  if (body.action === 'refinement_reserve_next') {
    object(body, ['action', 'repoPath', 'id', 'expectedRevision']); text(body.id, 128);
    integer(body.expectedRevision, 0, Number.MAX_SAFE_INTEGER);
    const state = journal.read(body.id);
    if (!state || state.manifest.repository !== repository) throw new Error('Refinement experiment not found in repository.');
    if (state.revision !== body.expectedRevision) throw new Error('Refinement revision conflict.');
    const next = advanceExperiment(state);
    return { state: next.revision === state.revision ? state : journal.append(next, state.revision), launch: 'held' };
  }
  if (body.action === 'refinement_prepare_packet') {
    object(body, ['action', 'repoPath', 'id', 'requestId', 'expectedRevision']);
    text(body.id, 128); text(body.requestId, 128); integer(body.expectedRevision, 0, Number.MAX_SAFE_INTEGER);
    const state = journal.read(body.id);
    if (!state || state.manifest.repository !== repository || state.revision !== body.expectedRevision
      || state.pending?.id !== body.requestId) throw new Error('Refinement pending request binding differs.');
    const { requireImprovementNamespace } = await import('./namespace');
    const namespace = requireImprovementNamespace();
    if (namespace.experimentId !== body.id || namespace.repository !== repository) throw new Error('Refinement namespace differs.');
    const { prepareImprovementMission } = await import('./mission-preparation');
    return prepareImprovementMission({ experimentId: body.id, requestId: body.requestId });
  }
  if (body.action === 'refinement_revoke_lesson') {
    object(body, ['action', 'repoPath', 'id', 'expectedRevision', 'lessonId', 'reason']);
    text(body.id, 128); text(body.lessonId, 128); text(body.reason, 1024);
    integer(body.expectedRevision, 0, Number.MAX_SAFE_INTEGER);
    const state = journal.read(body.id);
    if (!state || state.manifest.repository !== repository) throw new Error('Refinement experiment not found in repository.');
    if (state.revision !== body.expectedRevision) throw new Error('Refinement revision conflict.');
    const next = revokeExperimentLesson(state, body.lessonId, body.reason);
    return { state: next.revision === state.revision ? state : journal.append(next, state.revision), launch: 'held' };
  }
  if (body.action === 'refinement_observe_artifacts') {
    object(body, ['action', 'repoPath', 'id', 'requestId', 'expectedRevision', 'packetId', 'surfaceId', 'runId']);
    text(body.id, 128); text(body.requestId, 128); text(body.packetId, 256);
    text(body.surfaceId, 256); text(body.runId, 128); integer(body.expectedRevision, 0, Number.MAX_SAFE_INTEGER);
    const state = journal.read(body.id);
    if (!state || state.manifest.repository !== repository || state.revision !== body.expectedRevision
      || state.pending?.id !== body.requestId || state.pending.kind !== 'execute') {
      throw new Error('Refinement pending execution binding differs.');
    }
    const { requireImprovementNamespace } = await import('./namespace');
    const namespace = requireImprovementNamespace();
    if (namespace.experimentId !== body.id || namespace.repository !== repository) throw new Error('Refinement namespace differs.');
    const { collectRuntimeArtifactObservation } = await import('./runtime-artifact-observation');
    // Observation is never a receipt settlement, evaluator verdict or launch grant.
    return collectRuntimeArtifactObservation({ experimentId: body.id, requestId: body.requestId,
      packetId: body.packetId, surfaceId: body.surfaceId, runId: body.runId });
  }
  if (body.action === 'refinement_launch') {
    // Fail before packet creation, provider lookup or launch. A request body,
    // operator identity, manifest or native provenance declaration is no grant.
    throw new Error('Refinement launch is held: governed writable packet admission and verified isolated carrier are not installed.');
  }
  throw new Error('Unknown refinement action.');
}
