export const MACOS_RELEASE_TARGET: 'universal-apple-darwin';
export const MACOS_RELEASE_ARCHITECTURES: readonly ['x86_64', 'arm64'];

export interface MacosReleaseArtifacts {
  target: typeof MACOS_RELEASE_TARGET;
  bundleDir: string;
  app: string;
  updaterArchive: string;
  updaterSignature: string;
  dmg: string;
}

export interface MacosUniversalArtifactIdentity {
  kind: 'macos-universal-app';
  architectures: Array<'x86_64' | 'arm64'>;
  binaries: Array<{
    relativePath: string;
    architectures: Array<'x86_64' | 'arm64'>;
    sha256: string;
  }>;
}

export function readMachOArchitectures(path: string): Array<'x86_64' | 'arm64'>;
export function resolveMacosReleaseArtifacts(root: string, version: string): MacosReleaseArtifacts;
export function verifyUniversalMacApp(appPath: string): MacosUniversalArtifactIdentity;
