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
