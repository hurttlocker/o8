/**
 * Runtime System — Barrel Export + Auto-Registration
 *
 * Import this module to register all known runtimes.
 * New runtimes: add import + registerRuntime() call below.
 */

export type {
  RuntimeId,
  RuntimeCapabilities,
  RuntimeSession,
  RuntimeSessionStatus,
  RuntimeSessionOwnership,
  RuntimeTranscriptEntry,
  TranscriptRole,
  RuntimeChangedFile,
  FileChangeStatus,
  RuntimeActionResult,
  LaunchOptions,
  RuntimeTelemetry,
  AgentRuntime,
} from './types';

export type { SessionCostData } from './shared/cost-parser-registry';
export { registerCostParser, getCostParser, parseCost } from './shared/cost-parser-registry';

export {
  registerRuntime,
  getRuntime,
  getAllRuntimes,
  getRegisteredRuntimeIds,
  discoverAllSessions,
  routeAction,
} from './registry';

// ── Auto-registration ──
// Import and register all known runtimes.
// To add a new runtime: import it and call registerRuntime().

import { getRemoteRuntimeFlagSync } from '../worker/feature-flags';
import { registerRuntime } from './registry';
import { codexRuntime } from './codex';
import { claudeCodeRuntime } from './claude-code';
import { cloudRuntime } from './cloud-adapter';

registerRuntime(codexRuntime);
registerRuntime(claudeCodeRuntime);
// #514 — Cloud runtime adapter (Cursor-style self-hosted worker pool).
// Always registered so dispatch UI can target it; actual execution requires
// a worker CLI to connect to /api/cloud/worker-poll with a provisioned key.
registerRuntime(cloudRuntime);

// Remote-customer stays startup-gated for v1. We honor the environment
// override first, then the persisted Workers preference for the next launch.
if (getRemoteRuntimeFlagSync().enabled) {
  // Dynamic import to avoid loading DB-coupled transport code unless enabled.
  const { CustomerWorkerAdapter } = require('./remote/customer-worker-adapter');
  registerRuntime(new CustomerWorkerAdapter());
}
