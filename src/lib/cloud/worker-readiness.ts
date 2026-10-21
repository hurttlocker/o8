import 'server-only';

import { DEFAULT_CLOUD_TEAM_ID } from './team';
import { listConnectedCloudWorkers } from './worker-presence';
import { getRuntimeCapability } from '@/lib/orchestrator/runtime-capabilities';

export function getRemoteWorkerAvailability() {
  const connectedWorkers = listConnectedCloudWorkers(Date.now(), DEFAULT_CLOUD_TEAM_ID).length;
  return {
    available: connectedWorkers > 0,
    connectedWorkers,
    detail: connectedWorkers > 0
      ? `${connectedWorkers} remote worker${connectedWorkers === 1 ? '' : 's'} connected. Tasks queue for the pool; capacity and execution are confirmed when claimed.`
      : 'No remote worker is connected to this execution pool.',
    fix: 'Start the standalone worker on the execution host with a scoped worker key, then retry. Remote tasks never fall back to this machine.',
  };
}

/** Checks presence, not remote installation, credentials, or idle capacity. */
export function remoteWorkerPreflightError(model?: string | null): string | null {
  if (model?.trim() && !getRuntimeCapability('cloud').modelIdPattern?.test(model.trim())) {
    return `Selected model "${model.trim()}" is not compatible with the remote Codex worker.`;
  }
  const status = getRemoteWorkerAvailability();
  return status.available ? null : `${status.detail} ${status.fix}`;
}
