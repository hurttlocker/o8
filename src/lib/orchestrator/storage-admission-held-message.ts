import 'server-only';

import type Database from 'better-sqlite3';

import { listLanes } from '@/lib/lane/registry';
import { listMissionRegistryEntries } from '@/lib/orchestrator/mission-registry';
import { packetTerminalState } from '@/lib/orchestrator/packet-state';
import type { OrchestratorPacketStorageAdmission } from '@/lib/orchestrator/types';
import type { StorageAdmissionPolicy } from '@/lib/workspace/storage-admission';

const GIB = 1024 * 1024 * 1024;

interface ReservedOwnerRow {
  owner_id: string;
  exact_bytes: number;
}

function terminalReservationHoldSummary(
  sqlite: Database.Database,
  volumeId: string,
): { bytes: number; packets: number } {
  const terminalOwners = new Set<string>();
  for (const entry of listMissionRegistryEntries({ includeArchived: true })) {
    for (const packet of entry.mission.packets) {
      const terminal = packetTerminalState(packet);
      if (terminal === 'released' || terminal === 'archived') {
        terminalOwners.add(packet.id);
      }
    }
  }
  for (const lane of listLanes()) {
    if (lane.packetId && (lane.status === 'completed' || lane.status === 'archived')) {
      terminalOwners.add(lane.packetId);
    }
  }
  const rows = sqlite.prepare(`
    SELECT owner_id, exact_bytes FROM storage_admission_reservations
    WHERE volume_id = ? AND state = 'reserved'
  `).all(volumeId) as ReservedOwnerRow[];
  const held = rows.filter((row) => terminalOwners.has(row.owner_id));
  return {
    bytes: held.reduce((sum, row) => sum + row.exact_bytes, 0),
    packets: new Set(held.map((row) => row.owner_id)).size,
  };
}

function formatStorageGigabytes(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

function formatStorageReservePercent(ratio: number): string {
  const percent = ratio * 100;
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
}

function reserveBreachExplanation(
  receipt: OrchestratorPacketStorageAdmission,
  policy?: StorageAdmissionPolicy,
): string | null {
  const available = receipt.physicalAvailableBytes;
  const requiredReserve = receipt.requiredReserveBytes;
  const headroom = receipt.dispatchHeadroomBytes;
  if (
    available === null
    || requiredReserve === null
    || headroom === null
    || !Number.isSafeInteger(available)
    || !Number.isSafeInteger(requiredReserve)
    || !Number.isSafeInteger(headroom)
  ) return null;
  const reserveShortfall = Math.max(0, -headroom);
  const dispatchShortfall = Math.max(0, receipt.estimateBytes - headroom);
  const activeReserved = receipt.reservedBeforeBytes ?? 0;
  const policySummary = policy?.reserveRatio !== undefined
    && policy.absoluteFloorBytes !== undefined
    ? `Storage policy keeps ${formatStorageReservePercent(policy.reserveRatio)}% of disk or ${formatStorageGigabytes(policy.absoluteFloorBytes)}, whichever is greater, unallocated.`
    : 'Storage policy requires the reported reserve to remain unallocated.';
  const reservationSummary = activeReserved > 0
    ? ` ${formatStorageGigabytes(activeReserved)} is already reserved for other launches.`
    : '';
  const reserveSummary = reserveShortfall > 0
    ? ` The volume is ${formatStorageGigabytes(reserveShortfall)} below that reserve.`
    : '';
  return `${policySummary} This volume requires ${formatStorageGigabytes(requiredReserve)} free; ${formatStorageGigabytes(available)} is available.${reservationSummary}${reserveSummary} Free ${formatStorageGigabytes(dispatchShortfall)} more to dispatch this packet's ${formatStorageGigabytes(receipt.estimateBytes)} estimate while preserving the reserve.`;
}

export function storageAdmissionHeldMessage(
  receipt: OrchestratorPacketStorageAdmission,
  sqlite: Database.Database,
  policy?: StorageAdmissionPolicy,
): string {
  const base = `Dispatch held by storage admission (${receipt.reason}).`;
  if (receipt.reason !== 'reserve_breached') return base;
  const capacity = reserveBreachExplanation(receipt, policy);
  const explained = capacity ? `${base} ${capacity}` : base;
  if (!receipt.volumeId) return explained;
  let terminal: ReturnType<typeof terminalReservationHoldSummary>;
  try {
    terminal = terminalReservationHoldSummary(sqlite, receipt.volumeId);
  } catch {
    return explained;
  }
  if (terminal.packets === 0) return explained;
  const gib = (terminal.bytes / GIB).toFixed(2);
  return `${explained} ${gib} GB held by ${terminal.packets} terminal packet${terminal.packets === 1 ? '' : 's'}.`;
}
