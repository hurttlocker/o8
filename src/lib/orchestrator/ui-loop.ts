import 'server-only';

import { resolve } from 'node:path';
import { recordLaneEvent } from '@/lib/lane/events';
import { listMissionRegistryEntries } from '@/lib/orchestrator/mission-registry';
import { packetTerminalState } from '@/lib/orchestrator/packet-state';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import {
  findSteerablePacketLane,
  isNoSteerableSessionError,
  steerPacket,
} from '@/lib/orchestrator/operator-mission-service/steer';
import { currentMissionState } from '@/lib/orchestrator/operator-mission-service/shared';

export interface WarmUiLoopPacket {
  packetId: string;
  laneId: string;
  lastActivityAt: string;
  label: string;
}

export type UiLoopSteerResult =
  | {
      kind: 'steered';
      packet: WarmUiLoopPacket;
      imageForwarded: boolean;
    }
  | {
      kind: 'fallback';
      reason: 'NO_WARM_UI_LOOP_PACKET' | 'NO_STEERABLE_SESSION';
    };

function normalizeRepoPath(repoPath: string): string {
  return resolve(repoPath.trim());
}

function activityAt(
  mission: OrchestratorMissionState,
  packet: OrchestratorPacket,
  lane: NonNullable<ReturnType<typeof findSteerablePacketLane>>,
): string {
  const candidates = [lane.lastEventAt, lane.updatedAt, packet.lastEventAt, mission.updatedAt]
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((candidate) => Number.isFinite(candidate.time))
    .sort((left, right) => right.time - left.time);
  return candidates[0]?.value ?? new Date(0).toISOString();
}

function packetLabel(packet: OrchestratorPacket, laneLabel: string): string {
  const issueNumber = packet.issue?.url && typeof packet.issue.number === 'number'
    ? packet.issue.number
    : null;
  return issueNumber ? `#${issueNumber}` : laneLabel.trim() || packet.referenceLabel || packet.id;
}

function elementSummary(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const element = lines.find((line) => line.startsWith('Element:'));
  const selector = lines.find((line) => line.startsWith('Selector:'));
  return [element, selector].filter(Boolean).join(' · ').slice(0, 300)
    || lines[0]?.slice(0, 300)
    || 'Design Mode element edit';
}

export function findWarmUiLoopPacket(repoPath: string): WarmUiLoopPacket | null {
  const targetRepoPath = normalizeRepoPath(repoPath);
  const current = currentMissionState();
  const missions = [
    current,
    ...listMissionRegistryEntries({
      includeArchived: false,
      excludeMissionId: current.missionId,
    }).map((entry) => entry.mission),
  ];
  const candidates = new Map<string, WarmUiLoopPacket>();

  for (const mission of missions) {
    for (const packet of mission.packets) {
      const packetRepoPath = packet.workspaceTargetPath ?? mission.repoPath;
      if (!packetRepoPath || normalizeRepoPath(packetRepoPath) !== targetRepoPath) continue;
      if (packet.origin !== 'design-mode' || packetTerminalState(packet)) continue;
      const lane = findSteerablePacketLane(packet.id);
      if (!lane) continue;
      const candidate = {
        packetId: packet.id,
        laneId: lane.id,
        lastActivityAt: activityAt(mission, packet, lane),
        label: packetLabel(packet, lane.label),
      } satisfies WarmUiLoopPacket;
      const previous = candidates.get(packet.id);
      if (!previous || Date.parse(candidate.lastActivityAt) > Date.parse(previous.lastActivityAt)) {
        candidates.set(packet.id, candidate);
      }
    }
  }

  return Array.from(candidates.values())
    .sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt))[0]
    ?? null;
}

export async function steerWarmUiLoop(input: {
  repoPath: string;
  text: string;
  previewImageDataUri?: string;
}): Promise<UiLoopSteerResult> {
  const packet = findWarmUiLoopPacket(input.repoPath);
  if (!packet) return { kind: 'fallback', reason: 'NO_WARM_UI_LOOP_PACKET' };

  const text = input.text.trim();
  const message = input.previewImageDataUri
    ? `${text}\n\nScreenshot note: warm-session steer cannot attach the element crop, so use the element, selector, accessibility, and style context above.`
    : text;
  try {
    const result = await steerPacket({
      packetId: packet.packetId,
      message,
      source: 'operator',
    });
    recordLaneEvent(result.laneId, 'ui_loop_steered', 'orchestrator', {
      packetId: result.packetId,
      elementSummary: elementSummary(text),
    });
    return {
      kind: 'steered',
      packet: { ...packet, laneId: result.laneId },
      imageForwarded: false,
    };
  } catch (error) {
    if (isNoSteerableSessionError(error)) {
      return { kind: 'fallback', reason: 'NO_STEERABLE_SESSION' };
    }
    throw error;
  }
}
