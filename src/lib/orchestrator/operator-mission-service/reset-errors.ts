export class ResetKillUnconfirmedError extends Error {}

export class ResetSessionArchiveUnconfirmedError extends Error {}

export interface ResetCleanupFailureResult {
  reset: false;
  salvaged: false;
  partial: true;
  packetId: string;
  referenceLabel: string;
  worktreePruned: boolean;
  branchDeleted: boolean;
  note: string;
}

export class ResetCleanupFailedError extends Error {
  constructor(public readonly result: ResetCleanupFailureResult) {
    super(result.note);
    this.name = 'ResetCleanupFailedError';
  }
}

export class ResetStateChangedError extends Error {}

/** The packet is in no mission and has no lane, so there is nothing to reset. */
export class ResetPacketNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResetPacketNotFoundError';
  }
}

export class ResetRetrySalvagePublicationError extends Error {}
