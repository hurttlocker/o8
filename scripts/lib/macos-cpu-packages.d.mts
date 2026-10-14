import type { MacosArchitecture, MacosCpuArtifactIdentity, MacosCpuArtifacts } from './macos-release-artifacts.mjs';

export function macosSigningPolicy(path: string, architecture: MacosArchitecture): {
  identifier: string; team: string; flags: string; runtime: string | null; requirements: string; entitlements: unknown;
};

export function verifyMacCpuDerivation(universalApp: string, cpuApp: string, architecture: MacosArchitecture):
  MacosCpuArtifactIdentity & { sharedResourcesSha256: string };
export function prepareMacosCpuPackages(root: string, version: string):
  Array<MacosCpuArtifacts & { identity: MacosCpuArtifactIdentity & { sharedResourcesSha256: string } }>;
export function assertCpuPreparationCurrent(root: string, version: string, architecture: MacosArchitecture):
  MacosCpuArtifactIdentity & { sharedResourcesSha256: string };
