export interface InteractionConfig {
  scales: number[];
  seed: number;
  samples: number;
  soakMs: number;
  injectedDelayMs: number;
  bootTimeoutMs: number;
  composerTimeoutMs: number;
  revealTimeoutMs: number;
  inventoryTimeoutMs: number;
  requestedBuildMode: string;
  target: { kind: 'source' | 'release'; appPath: string | null };
  archiveSha256: string | null;
  releaseGitSha: string | null;
  outputPath: string;
  baselinePath: string;
  composeTerminalWorkload: boolean;
  writeBaseline: boolean;
  reportOnly: boolean;
}

export function interactionConfig(root: string, argv?: string[]): InteractionConfig;
export function baselineWriteProblems(receipt: unknown): string[];
