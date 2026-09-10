export class HeadShaMismatchError extends Error {
  readonly packetId: string;
  readonly expectedHeadSha: string;
  readonly currentHeadSha: string;

  constructor(packetId: string, expectedHeadSha: string, currentHeadSha: string) {
    super(`Worktree HEAD changed since review for packet ${packetId}: expected ${expectedHeadSha}, current ${currentHeadSha}. Re-review before merging.`);
    this.name = 'HeadShaMismatchError';
    this.packetId = packetId;
    this.expectedHeadSha = expectedHeadSha;
    this.currentHeadSha = currentHeadSha;
  }
}

export function isHeadShaMismatchError(error: unknown): error is HeadShaMismatchError {
  return error instanceof HeadShaMismatchError;
}
