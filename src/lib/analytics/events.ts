import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { isOrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';

export type ProductEventName =
  | 'app.opened'
  | 'brain.asked'
  | 'orchestrator.message'
  | 'dispatch.started'
  | 'merge.approved'
  | 'repo.added';

export type ProductEventProps = Partial<{
  runtime: OrchestratorRuntime;
  pushed: boolean;
  hasRemote: boolean;
  isGitRepo: boolean;
}>;

export type ProductEventPayload =
  | { event: 'app.opened' | 'brain.asked' | 'orchestrator.message' }
  | { event: 'dispatch.started'; props: { runtime: OrchestratorRuntime } }
  | { event: 'merge.approved'; props: { runtime: OrchestratorRuntime; pushed: boolean } }
  | { event: 'repo.added'; props: { hasRemote: boolean; isGitRepo: boolean } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAllowedRuntime(value: unknown): value is OrchestratorRuntime {
  return isOrchestratorRuntime(value);
}

/**
 * The complete product-telemetry wire allowlist. Unknown events, missing fields,
 * and non-enum values fail closed; extra properties are discarded.
 */
export function sanitizeProductEvent(event: unknown, props?: unknown): ProductEventPayload | null {
  if (event === 'app.opened' || event === 'brain.asked' || event === 'orchestrator.message') return { event };
  if (!isRecord(props)) return null;

  if (event === 'dispatch.started' && isAllowedRuntime(props.runtime)) {
    return { event, props: { runtime: props.runtime } };
  }
  if (event === 'merge.approved' && isAllowedRuntime(props.runtime) && typeof props.pushed === 'boolean') {
    return { event, props: { runtime: props.runtime, pushed: props.pushed } };
  }
  if (event === 'repo.added' && typeof props.hasRemote === 'boolean' && typeof props.isGitRepo === 'boolean') {
    return { event, props: { hasRemote: props.hasRemote, isGitRepo: props.isGitRepo } };
  }
  return null;
}
