export type RepoSetupEnvMode = 'copy' | 'symlink' | 'skip';

export interface RepoSetupConfig {
  envMode: RepoSetupEnvMode;
  envFiles: string[];
  installCommand: string | null;
  installOnCreateWorkspace: boolean;
  buildCommand: string | null;
  runBuildOnCreateWorkspace: boolean;
  devCommand: string | null;
  defaultPort: number | null;
}

export interface RepoRegistryEntry {
  id: string;
  name: string;
  localPath: string;
  remoteUrl: string | null;
  defaultBranch: string;
  addedAt: string;
  lastOpenedAt: string | null;
  setup: RepoSetupConfig;
}

export interface RepoRegistryStore {
  version: 1;
  repos: RepoRegistryEntry[];
}

export interface ValidatedRepoCandidate {
  name: string;
  localPath: string;
  remoteUrl: string | null;
  defaultBranch: string;
  setup: RepoSetupConfig;
}

export interface RepoRegistryDeleteBody {
  id: string;
}

export interface RepoRegistryValidateBody {
  action: 'validate';
  localPath: string;
}

export interface RepoRegistryAddBody {
  action?: 'add';
  localPath: string;
}

export interface RepoRegistryUpdateBody {
  action: 'update';
  id: string;
  setup?: RepoSetupConfig;
  lastOpenedAt?: string | null;
}

export interface RepoRegistryTouchBody {
  action: 'touch';
  id: string;
  lastOpenedAt?: string | null;
}

export type RepoRegistryPostBody =
  | RepoRegistryValidateBody
  | RepoRegistryAddBody
  | RepoRegistryUpdateBody
  | RepoRegistryTouchBody;
