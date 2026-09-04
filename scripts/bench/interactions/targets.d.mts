export interface InteractionTarget {
  kind: 'source' | 'release';
  appPath: string | null;
}

export interface ReleaseArtifactIdentity {
  appPath: string;
  serverDir: string | null;
  bundleVersion: string | null;
  bundleBuildVersion?: string | null;
  bundleIdentifier?: string | null;
  executableName?: string | null;
  executableSha256?: string | null;
  serverEntrySha256?: string | null;
  releaseGitSha?: string | null;
  targetDigestSha256?: string | null;
  complete?: boolean;
  identityProblems?: string[];
  buildId?: string | null;
  unavailableReason: string | null;
}

export const DEFAULT_RELEASE_APP_PATH: string;

export function parseTargetOption(raw: unknown): InteractionTarget;
export function resolveReleaseServerDir(appPath: string): string | null;
export function releaseArtifactIdentity(appPath: string, options?: { archiveSha256?: string | null; releaseGitSha?: string | null }): ReleaseArtifactIdentity;
export function packagedTargetIdentityProblems(target: Record<string, unknown>, stack: Record<string, unknown>): string[];
export function startReleaseArtifactStack(
  root: string,
  fixture: { dataDir: string },
  appPath: string,
  options?: { timeoutMs?: number; runTag?: string | null; archiveSha256?: string | null; releaseGitSha?: string | null },
): Promise<Record<string, unknown>>;
export function startTargetStack(
  root: string,
  fixture: { dataDir: string },
  target: InteractionTarget,
  requestedBuildMode: string,
  options?: { timeoutMs?: number; runTag?: string | null; archiveSha256?: string | null; releaseGitSha?: string | null },
): Promise<Record<string, unknown>>;
