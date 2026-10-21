export const MAX_GOVERNED_TERMINAL_WRITE_BYTES = 64 * 1024;
// JSON escaping can expand one input byte to six (\u001b), so the request cap
// leaves room for a full write plus its envelope and refuses anything larger
// before it is buffered or parsed.
export const MAX_GOVERNED_TERMINAL_REQUEST_BYTES = 8 * MAX_GOVERNED_TERMINAL_WRITE_BYTES;

export type GovernedTerminalWriteErrorCode =
  | 'invalid_terminal_action'
  | 'terminal_not_found'
  | 'terminal_not_packet_owned'
  | 'terminal_packet_mismatch'
  | 'terminal_busy'
  | 'terminal_audit_unavailable'
  | 'terminal_write_failed';

export class GovernedTerminalWriteError extends Error {
  constructor(
    readonly code: GovernedTerminalWriteErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GovernedTerminalWriteError';
  }
}

export interface GovernedTerminalTarget {
  sessionId: string;
  packetId: string | null;
  laneId: string | null;
  controlHeld: boolean;
  write(data: string): void;
  markInput(at: number): void;
}

export interface GovernedTerminalActionReceipt {
  packetId: string;
  sessionId: string;
  laneId: string;
  byteCount: number;
  reason: string;
  recordedAt: string;
}

export interface GovernedTerminalWriteDeps {
  resolveTarget(sessionId: string): GovernedTerminalTarget | null;
  record(
    laneId: string,
    payload: {
      packetId: string;
      sessionId: string;
      byteCount: number;
      reason: string;
      principal: 'worker';
      result: 'attempted';
    },
  ): void;
  now?: () => number;
}

const PACKET_ID = /^[A-Za-z0-9_-]{1,160}$/;
const SESSION_ID = /^cortex-[A-Za-z0-9_-]{1,200}$/;

function invalid(message: string): never {
  throw new GovernedTerminalWriteError('invalid_terminal_action', 400, message);
}

/**
 * Single mutation seam for packet-worker terminal input.
 *
 * The packet id must come from an authenticated worker credential, never the
 * request body. The durable event is persisted before PTY mutation so a write
 * can never occur without an audit trace. Human/operator terminal input keeps
 * using the ordinary terminal path.
 */
export function writeGovernedAgentTerminal(
  input: { packetId: string; sessionId: string; data: string; reason: string },
  deps: GovernedTerminalWriteDeps,
): GovernedTerminalActionReceipt {
  const packetId = input.packetId.trim();
  const sessionId = input.sessionId.trim();
  const reason = input.reason.trim();

  if (!PACKET_ID.test(packetId)) invalid('A valid packet id is required.');
  if (!SESSION_ID.test(sessionId)) invalid('A valid terminal session id is required.');
  if (typeof input.data !== 'string' || input.data.length === 0) invalid('Terminal input data is required.');
  if (!reason || reason.length > 240) invalid('A terminal action reason between 1 and 240 characters is required.');

  const byteCount = Buffer.byteLength(input.data, 'utf8');
  if (byteCount > MAX_GOVERNED_TERMINAL_WRITE_BYTES) {
    invalid(`Terminal input exceeds the ${MAX_GOVERNED_TERMINAL_WRITE_BYTES}-byte limit.`);
  }

  const target = deps.resolveTarget(sessionId);
  if (!target) {
    throw new GovernedTerminalWriteError('terminal_not_found', 404, 'Terminal session not found.');
  }
  if (!target.packetId || !target.laneId) {
    throw new GovernedTerminalWriteError(
      'terminal_not_packet_owned',
      403,
      'Agent writes require a packet-owned terminal session.',
    );
  }
  if (target.packetId !== packetId) {
    throw new GovernedTerminalWriteError(
      'terminal_packet_mismatch',
      403,
      `Worker packet ${packetId} does not own terminal ${sessionId}.`,
    );
  }
  if (target.controlHeld) {
    throw new GovernedTerminalWriteError(
      'terminal_busy',
      409,
      'Terminal has an active operator control lease.',
    );
  }

  const now = deps.now?.() ?? Date.now();
  try {
    deps.record(target.laneId, {
      packetId,
      sessionId,
      byteCount,
      reason,
      principal: 'worker',
      result: 'attempted',
    });
  } catch {
    throw new GovernedTerminalWriteError(
      'terminal_audit_unavailable',
      503,
      'Terminal action could not be durably recorded.',
    );
  }

  try {
    target.write(input.data);
    target.markInput(now);
  } catch {
    throw new GovernedTerminalWriteError(
      'terminal_write_failed',
      409,
      'Terminal session exited before the governed write completed.',
    );
  }

  return {
    packetId,
    sessionId,
    laneId: target.laneId,
    byteCount,
    reason,
    recordedAt: new Date(now).toISOString(),
  };
}
