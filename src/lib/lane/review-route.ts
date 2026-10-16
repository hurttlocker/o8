/**
 * Review route (#3742). A CLI reviewer (Claude or Codex) keeps reviewing when
 * its CLI is installed, so nothing changes for people who have one. Without it the
 * review runs on o8's own Pi: on the packet's OpenRouter model when the packet
 * ran on one, otherwise on the managed Pi model.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { executableSuffixes, scanForBinary } from '@/lib/runtimes/shared/cli-locate';
import { findMissionRegistryEntryByPacketId } from '@/lib/orchestrator/mission-registry';
import { isOpenRouterPiModelChoice } from '@/lib/pi/sdk/openrouter-model-choice';
import { resolveReviewerBackendId } from './orchestrator-backends/active-backend';
import type { OrchestratorBackendId } from './orchestrator-backends/types';
import { getLane } from './registry';

/** Reviewer backends that need a local CLI: the binary and its path overrides. */
const CLI_REVIEWERS: Partial<Record<OrchestratorBackendId, { binary: string; overrides: string[] }>> = {
  claude: { binary: 'claude', overrides: ['O8_CLAUDE_CODE_BIN', 'CLAUDE_BIN'] },
  codex: { binary: 'codex', overrides: ['O8_CODEX_BIN'] },
};

/**
 * Installed, found without spawning: an override path that exists, else the
 * well-known CLI directories, else any PATH entry (what `which` would find).
 * A missing override path is skipped, as the CLI resolver skips it.
 */
function cliInstalled(cli: { binary: string; overrides: string[] }): boolean {
  if (cli.overrides.some((name) => { const value = process.env[name]?.trim(); return value && existsSync(value); })) return true;
  if (scanForBinary(cli.binary) !== null) return true;
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).some((dir) =>
    executableSuffixes().some((suffix) => existsSync(path.join(dir, `${cli.binary}${suffix}`))));
}

export interface ReviewRoute {
  backend: OrchestratorBackendId;
  /** Model for a Pi review: an `openrouter/<id>` choice, or undefined for managed Pi. */
  model?: string;
  /** Set when the configured reviewer could not run and the review moved to Pi. */
  reason?: string;
}

function packetOpenRouterModel(laneId: string): string | undefined {
  const lane = getLane(laneId);
  const packetModel = lane?.packetId
    ? findMissionRegistryEntryByPacketId(lane.packetId, { includeArchived: true })?.mission.packets
      .find((packet) => packet.id === lane.packetId)?.assignedModel
    : undefined;
  return [lane?.model, packetModel].find((model): model is string => isOpenRouterPiModelChoice(model));
}

export function resolveReviewRoute(laneId: string): ReviewRoute {
  const configured = resolveReviewerBackendId();
  const cli = CLI_REVIEWERS[configured];
  if (cli && !cliInstalled(cli)) {
    return {
      backend: 'pi',
      model: packetOpenRouterModel(laneId),
      reason: `The ${configured} CLI is not installed, so the review runs on o8's Pi.`,
    };
  }
  return configured === 'pi' ? { backend: 'pi', model: packetOpenRouterModel(laneId) } : { backend: configured };
}
