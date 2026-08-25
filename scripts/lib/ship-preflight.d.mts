export interface ShipCommandReceipt {
  status: number;
  stdout: string;
  stderr: string;
}

export interface ShipPreflightReceipt {
  schema: 'o8/release-preflight/v1';
  head: string;
  version: string;
  tag: string;
  remoteTagHead: string;
  releaseAbsent: boolean;
  availableGiB: number;
  minFreeGiB: number;
  credentialNames: string[];
  signingKeyPresent: boolean;
  toolchains: Record<string, string>;
}

export function acquireReleaseLock(options?: { lockPath?: string }): {
  path: string;
  release(): void;
};
export function performShipPreflight(options: {
  root: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  run?: (command: string, args: string[], options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }) => ShipCommandReceipt;
}): ShipPreflightReceipt;
