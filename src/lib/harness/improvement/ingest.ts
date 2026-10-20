import { settleExperiment } from './engine';
import { object } from './validation';
import type { ImprovementExperiment, ImprovementReceipt } from './types';

/** Trusted transport observation must come from the admitted adapter, NEVER model JSON. */
export type TerminalObservation = Pick<ImprovementReceipt,
  'requestId' | 'requestDigest' | 'provenance' | 'runtime' | 'model' | 'effort' | 'usage'>;

/**
 * A terminal model attempt has spent its budget even when its output is invalid.
 * Validate the transport independently first. Only model-payload errors become a
 * failed stage; stale reservations, pin mismatches and corrupt state still throw.
 * Raw invalid output is intentionally not persisted (may contain secrets/grades).
 */
export function ingestTerminalOutput(
  state: ImprovementExperiment, observation: TerminalObservation, output: unknown,
): ImprovementExperiment {
  object(observation, ['requestId', 'requestDigest', 'provenance', 'runtime', 'model', 'effort', 'usage']);
  const failed: ImprovementReceipt = { ...observation, status: 'failed', failureReason: 'invalid_stage_output' };
  const rejectedState = settleExperiment(state, failed);
  try {
    const payload = object(output, ['harness', 'artifact', 'trajectory', 'choice', 'lesson', 'decisions'], []);
    return settleExperiment(state, { ...observation, ...payload, status: 'completed' });
  } catch {
    return rejectedState;
  }
}
