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

export type { SessionCostData } from './cost-parser';

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

registerRuntime(codexRuntime);
registerRuntime(claudeCodeRuntime);

// Remote-customer stays startup-gated for v1. We honor the environment
// override first, then the persisted Workers preference for the next launch.
if (getRemoteRuntimeFlagSync().enabled) {
  // Dynamic import to avoid loading DB-coupled transport code unless enabled.
  const { CustomerWorkerAdapter } = require('./remote/customer-worker-adapter');
  registerRuntime(new CustomerWorkerAdapter());
}
