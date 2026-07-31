export interface PacketStatusWriteRejection {
  code: 'packet_status_write_unsupported';
  message: string;
  field: 'status';
  requestedValue: unknown;
  correctVerb: string;
}

const STATUS_TRANSITION_VERBS: Record<string, string> = {
  archived: 'close_packet_unmerged',
  released: 'approve_and_merge',
  awaiting_review: 'submit_review',
  draft: 'reset_packet',
  queued: 'dispatch_mission',
  launching: 'dispatch_mission',
  running: 'dispatch_mission',
  idle: 'reset_packet',
  blocked: 'stop_packet',
  failed: 'reset_packet',
  recovering: 'retry_packet',
};

export function packetStatusWriteRejection(
  updates: Record<string, unknown>,
): PacketStatusWriteRejection | null {
  if (!Object.prototype.hasOwnProperty.call(updates, 'status')) return null;

  const requestedValue = updates.status;
  const correctVerb = typeof requestedValue === 'string'
    ? STATUS_TRANSITION_VERBS[requestedValue] ?? 'the packet lane lifecycle API'
    : 'the packet lane lifecycle API';

  return {
    code: 'packet_status_write_unsupported',
    message: `Packet status is lane-derived and cannot be patched directly. Use ${correctVerb} for this transition.`,
    field: 'status',
    requestedValue,
    correctVerb,
  };
}
