export const WORKSPACE_MANIFEST_FILENAME = 'o8.workspace.json';
export const WORKSPACE_MANIFEST_VERSION = 1 as const;

export interface WorkspaceManifestServicePort {
  preferred: number;
  env?: string;
}

export interface WorkspaceManifestServiceHealth {
  http?: string;
  tcp?: true;
  timeoutMs?: number;
}

export interface WorkspaceManifestService {
  name: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  port?: WorkspaceManifestServicePort;
  health?: WorkspaceManifestServiceHealth;
}

export interface WorkspaceManifestPreview {
  url: string;
}

export interface WorkspaceManifestV1 {
  version: typeof WORKSPACE_MANIFEST_VERSION;
  setup?: string[];
  teardown?: string[];
  services?: WorkspaceManifestService[];
  preview?: WorkspaceManifestPreview;
}

export type WorkspaceManifest = WorkspaceManifestV1;
