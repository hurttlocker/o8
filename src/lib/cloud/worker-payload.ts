import type { LaunchOptions } from '@/lib/runtimes/types';

/** Fields a scoped external worker may receive from the coordinator. */
export function workerLaunchPayload(launch: LaunchOptions) {
  return {
    prompt: launch.prompt,
    model: launch.model,
    effort: launch.effort,
    packetId: launch.packetId,
    workMode: launch.workMode,
    remoteSource: launch.remoteSource,
    remoteManifestHash: launch.remoteManifestHash,
    remotePreview: launch.remotePreview,
  };
}
