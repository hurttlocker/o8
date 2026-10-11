import type { MacosUniversalArtifactIdentity } from './macos-release-artifacts.mjs';

export const REMOTE_RELEASE_APP_SCHEMA: 'o8/remote-release-app/v1';
export const REMOTE_RELEASE_APP_IMPORT_SCHEMA: 'o8/remote-release-app-import/v1';
export interface RemoteReleaseAppSource {
  head: string;
  tree: string;
  version: string;
  bundleIdentifier: string;
  inputsSha256: string;
  productionConfigSha256: string;
  buildOptions: {
    target: string;
    nodeEnv: string;
    nextBundler: string;
    tauriFeatures: string[];
    signing: string;
  };
}
export interface RemoteReleaseAppManifest {
  schema: typeof REMOTE_RELEASE_APP_SCHEMA;
  createdAt: string;
  source: RemoteReleaseAppSource;
  app: {
    name: 'o8.app';
    inventory: Array<{
      path: string;
      kind: 'file' | 'directory' | 'symlink';
      mode: number;
      size?: number;
      sha256?: string;
      target?: string;
    }>;
    bundleSha256: string;
    universal: MacosUniversalArtifactIdentity;
  };
}
interface HandoffOptions {
  root: string;
  manifestPath: string;
  env?: NodeJS.ProcessEnv;
}
export function collectRemoteReleaseAppSource(root: string, env?: NodeJS.ProcessEnv): RemoteReleaseAppSource;
export function writeRemoteReleaseAppManifest(options: {
  root: string;
  appPath: string;
  outputPath: string;
  env?: NodeJS.ProcessEnv;
}): { manifestPath: string; manifest: RemoteReleaseAppManifest };
export function verifyRemoteReleaseAppManifest(options: HandoffOptions): {
  manifest: RemoteReleaseAppManifest;
  appPath: string;
  manifestSha256: string;
};
export function importRemoteReleaseApp(options: HandoffOptions): {
  appPath: string;
  receiptPath: string;
  receipt: {
    schema: typeof REMOTE_RELEASE_APP_IMPORT_SCHEMA;
    createdAt: string;
    manifestSha256: string;
    source: RemoteReleaseAppSource;
    bundleSha256: string;
    destination: string;
    previousApp: string | null;
  };
};
