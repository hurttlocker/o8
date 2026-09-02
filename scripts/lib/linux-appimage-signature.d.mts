import type { ReleaseUpdaterManifest, ReleaseUpdaterPlatform } from './release-manifest.d.mts';

export const SIGNER_COMMAND: string;
export const SIGNER_ARGS: string[];
export const GH_COMMAND: string;
export const SIGNING_KEY_ENV: string;
export const SIGNING_KEY_PASSWORD_ENV: string;
export const SIGNING_KEY_RELATIVE_PATH: string[];
export const DARWIN_UPDATER_ASSET: string;
export const LATEST_JSON_ASSET: string;
export const DEFAULT_REPOS: string[];

export function versionFromTag(tag: string): string;

export function resolveSigningKey(options?: {
  env?: Record<string, string | undefined>;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string;
}): string;

export function withLinuxPlatform(options: {
  latest: ReleaseUpdaterManifest;
  version: string;
  signature: string;
}): ReleaseUpdaterManifest;

export interface LinuxSignatureRunOptions {
  capture?: boolean;
  env?: Record<string, string | undefined>;
}

export interface LinuxSignatureDeps {
  resolveSigningKey: () => string | Promise<string>;
  fetchRelease: (options: { repo: string; tag: string }) =>
    | { isDraft: boolean; assets: string[] }
    | null
    | Promise<{ isDraft: boolean; assets: string[] } | null>;
  downloadAsset: (options: { repo: string; tag: string; assetName: string; destDir: string }) => string | Promise<string>;
  signAppImage: (options: { filePath: string; signingKey: string }) => string | Promise<string>;
  readSignature: (options: { sigPath: string }) => string | Promise<string>;
  fetchLatestJson: (options: { repo: string; tag: string; destDir: string }) =>
    | ReleaseUpdaterManifest
    | Promise<ReleaseUpdaterManifest>;
  writeLatestJson: (options: { path: string; latest: ReleaseUpdaterManifest }) => void | Promise<void>;
  uploadAssets: (options: { repo: string; tag: string; files: string[] }) => void | Promise<void>;
}

export function createLinuxSignatureDeps(options?: {
  run?: (command: string, args: string[], options?: LinuxSignatureRunOptions) => string;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
  writeFile?: (path: string, contents: string) => void;
}): LinuxSignatureDeps;

export function signLinuxAppImage(options: {
  tag: string;
  repos?: string[];
  workDir: string;
  deps: LinuxSignatureDeps;
  log?: (message: string) => void;
}): Promise<{
  version: string;
  assetName: string;
  sigPath: string;
  latestJsonPath: string;
  latest: ReleaseUpdaterManifest;
  repos: string[];
}>;

export type { ReleaseUpdaterManifest, ReleaseUpdaterPlatform };
