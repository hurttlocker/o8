import { advanceExperiment, validatePersistedExperiment } from './engine';
import { digest } from './validation';
import type { ImprovementJournal } from './journal';
import type { ImprovementExperiment } from './types';
import { createNativeModelStageAdapter, type NativeModelStageAdapterOptions,
  type NativeModelStageAttempt, type NativeModelStageResult } from './model-adapter';

export interface ImprovementDriverHost {
  journal: ImprovementJournal;
  model: NativeModelStageAdapterOptions;
  /** Durable, append-only transport observation ledger; required even on pin mismatch. */
  persistAttempt(attempt: NativeModelStageAttempt): Promise<void>;
  /** Only a governed writable packet adapter may implement this. No default raw spawn. */
  execute?: (state: ImprovementExperiment, signal?: AbortSignal) => Promise<NativeModelStageResult>;
}
export interface ImprovementDriverResult {
  state: ImprovementExperiment;
  status: 'held' | 'completed' | 'advanced' | 'uncertain';
  reason: string | null;
}

/**
 * One durable stage, not an approval API. The host owns exact-contract approval,
 * confinement and budget admission. A crash-resumed pending reservation is NEVER
 * automatically dispatched; it requires explicit same-request reconciliation.
 */
export async function driveImprovementStage(host: ImprovementDriverHost, id: string,
  expectedRevision: number, signal?: AbortSignal): Promise<ImprovementDriverResult> {
  const state = host.journal.read(id);
  if (!state || state.revision !== expectedRevision) throw new Error('Experiment revision conflict.');
  validatePersistedExperiment(state);
  if (state.pending || state.status === 'blocked') return { state, status: 'held', reason: 'reconcile_existing_reservation' };
  const next = advanceExperiment(state);
  if (next.status !== 'pending') {
    const saved = next.revision === state.revision ? state : host.journal.append(next, state.revision);
    return { state: saved, status: saved.status === 'completed' ? 'completed' : 'held', reason: saved.blockedReason };
  }
  if (next.pending!.kind === 'execute' && !host.execute) {
    return { state, status: 'held', reason: 'governed_writable_packet_adapter_required' };
  }
  // The successful CAS is the sole local launch owner. Losers never call an adapter.
  const reserved = host.journal.append(next, state.revision);
  let result: NativeModelStageResult;
  try {
    result = next.pending!.kind === 'execute'
      ? await host.execute!(reserved, signal)
      : await createNativeModelStageAdapter(host.model).run(reserved, signal);
  } catch {
    return { state: reserved, status: 'uncertain', reason: 'adapter_outcome_unknown' };
  }
  // Persist transport usage BEFORE derived model state. If this fails, retain the
  // reservation and forbid retry; reconciliation must consult the provider ledger.
  try {
    if (result.attempt) await host.persistAttempt(result.attempt);
    validatePersistedExperiment(result.state);
    if (result.state.manifestDigest !== reserved.manifestDigest) throw new Error('Adapter changed experiment.');
    const saved = digest(result.state) === digest(reserved) ? reserved
      : host.journal.append(result.state, reserved.revision);
    return { state: saved, status: result.status === 'settled' ? 'advanced'
      : result.status === 'uncertain' ? 'uncertain' : 'held', reason: result.reason };
  } catch {
    return { state: reserved, status: 'uncertain', reason: 'observation_persistence_unknown' };
  }
}
