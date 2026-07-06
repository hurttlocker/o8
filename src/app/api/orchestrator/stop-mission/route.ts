import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getMissionStatus } from '@/lib/orchestrator/operator-mission-service';
import { stopPacket } from '@/lib/orchestrator/stop-packet';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type MissionPacket = {
  id?: unknown;
  status?: unknown;
};

function missionPackets(value: unknown): MissionPacket[] {
  if (!value || typeof value !== 'object') return [];
  const packets = (value as { packets?: unknown }).packets;
  return Array.isArray(packets) ? packets as MissionPacket[] : [];
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const missionId = typeof record.missionId === 'string' ? record.missionId.trim() : '';
  if (!missionId) {
    return operatorError('invalid_request', 'missionId is required.', 400);
  }

  try {
    const status = await getMissionStatus({ missionId, includeCost: false });
    const packetIds = missionPackets(status)
      .map((packet) => typeof packet.id === 'string' ? packet.id.trim() : '')
      .filter((id) => id.length > 0);

    if (packetIds.length === 0) {
      return operatorError('mission_empty', `No packets found for mission ${missionId}.`, 404);
    }

    const results = await Promise.all(packetIds.map(async (packetId) => {
      try {
        const result = await stopPacket(packetId);
        return { packetId, ok: true, ...result };
      } catch (error) {
        return {
          packetId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));

    const failures = results.filter((result) => !result.ok);
    return operatorSuccess({
      missionId,
      stoppedPackets: results.filter((result) => result.ok).length,
      failedPackets: failures.length,
      results,
    }, failures.length > 0 ? 207 : 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to stop mission.';
    return operatorError('stop_mission_failed', message, 500, error);
  }
}
