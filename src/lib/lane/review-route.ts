/**
 * Review route (#3742). A CLI reviewer (Claude or Codex) keeps reviewing when
 * its CLI is installed, so nothing changes for people who have one. Without it the
 * review runs on o8's own Pi: on the packet's OpenRouter model when the packet
 * ran on one, otherwise on the managed Pi model.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { executableSuffixes, resolveClaudeBinary, scanForBinary } from '@/lib/runtimes/shared/cli-locate';
import { findMissionRegistryEntryByPacketId } from '@/lib/orchestrator/mission-registry';
import { isOpenRouterPiModelChoice } from '@/lib/pi/sdk/openrouter-model-choice';
import { resolveReviewerBackendId } from './orchestrator-backends/active-backend';
import type { OrchestratorBackendId } from './orchestrator-backends/types';
import { getLane } from './registry';

/**
 * Codex is installed when found without spawning: an override path that exists,
 * else the well-known CLI directories, else any PATH entry (what `which` would
 * find). A missing override path is skipped, as the shared CLI resolver skips it.
 */
function codexInstalled(): boolean {
  const override = process.env.O8_CODEX_BIN?.trim();
  if (override && existsSync(override)) return true;
  if (scanForBinary('codex') !== null) return true;
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).some((dir) =>
    executableSuffixes().some((suffix) => existsSync(path.join(dir, `codex${suffix}`))));
}

/** Claude is installed exactly when the Claude backend's own resolver finds it. */
function claudeInstalled(): boolean {
  try {
    resolveClaudeBinary();
    return true;
  } catch {
    return false;
  }
}

/** Reviewer backends that need a local CLI. */
const CLI_REVIEWERS: Partial<Record<OrchestratorBackendId, () => boolean>> = {
  claude: claudeInstalled,
  codex: codexInstalled,
};

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
  const installed = CLI_REVIEWERS[configured];
  if (installed && !installed()) {
    return {
      backend: 'pi',
      model: packetOpenRouterModel(laneId),
      reason: `The ${configured} CLI is not installed, so the review runs on o8's Pi.`,
    };
  }
  return configured === 'pi' ? { backend: 'pi', model: packetOpenRouterModel(laneId) } : { backend: configured };
}
