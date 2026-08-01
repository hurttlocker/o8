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
import { geminiRuntime } from './gemini';
import { antigravityRuntime } from './antigravity';
import { cloudRuntime } from './cloud-adapter';
import { opencodeRuntime } from './opencode';
import { cursorRuntime } from './cursor';
import { grokRuntime } from './grok';
import { piRuntime } from './pi';
import { declarativeWorkerRuntimes, invalidateDeclarativeWorkerFleets } from './declarative-workers';
import { invalidateOwnedCodexFleetCache } from '@/lib/codex/owned';
import { invalidateOwnedClaudeCodeFleetCache } from '@/lib/claude-code/owned';
import { invalidateOwnedGeminiFleetCache } from '@/lib/gemini/owned';
import { invalidateOwnedOpencodeFleetCache } from '@/lib/opencode/owned';
import { invalidateOwnedCursorFleetCache } from '@/lib/cursor/owned';
import { invalidateOwnedGrokFleetCache } from '@/lib/grok/owned';
import { invalidateOwnedPiFleetCache } from '@/lib/pi/owned';
import './opencode-cost-parser';
import './cursor-cost-parser';
import './grok-cost-parser';
import './pi-cost-parser';

/**
 * Flush the fleet cache across all owned-session stores. Callers (e.g. the
 * active-workspace switch handler) use this to force the next fleet consumer
 * to rebuild, avoiding the up-to-20s TTL gap.
 */
export function invalidateAllOwnedFleets(): void {
  invalidateOwnedCodexFleetCache();
  invalidateOwnedClaudeCodeFleetCache();
  invalidateOwnedGeminiFleetCache();
  invalidateOwnedOpencodeFleetCache();
  invalidateOwnedCursorFleetCache();
  invalidateOwnedGrokFleetCache();
  invalidateOwnedPiFleetCache();
  invalidateDeclarativeWorkerFleets();
}

registerRuntime(codexRuntime);
registerRuntime(claudeCodeRuntime);
// Wave 2c: Gemini CLI as a first-class coding runtime, peer to Codex/Claude
// Code. Surfaces 'gemini-owned:' sessions, uses `gemini -p … --yolo
// --output-format stream-json` under the hood. See src/lib/gemini/owned.ts.
registerRuntime(geminiRuntime);
// Antigravity replaces Gemini CLI at the Google runtime layer, but is
// discovery-only until agy documents a resumable JSON/event contract.
registerRuntime(antigravityRuntime);
// Wave 2c: opencode CLI — multi-provider coding runtime via `opencode run
// --format json --model provider/model`. Sessions 'opencode-owned:' with
// 'ses_' prefixed threads. See src/lib/opencode/owned.ts.
registerRuntime(opencodeRuntime);
registerRuntime(cursorRuntime);
registerRuntime(grokRuntime);
// Runtime expansion P3: Pi (earendil-works/pi) — `pi --mode rpc` bidirectional
// JSONL with native steer. Sessions 'pi-owned:'. See src/lib/pi/owned.ts.
registerRuntime(piRuntime);
for (const runtime of declarativeWorkerRuntimes) registerRuntime(runtime);
// #514 — Cloud runtime adapter (self-hosted worker pool).
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
