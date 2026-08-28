export const RELEASE_ARTIFACT_MANIFEST: string;

export interface ReleaseArtifactRecipe {
  recipeSha256: string;
  worktreeClean?: boolean;
  [key: string]: unknown;
}

export interface ReleaseArtifactOutput {
  path: string;
  kind: 'file' | 'symlink';
  sha256: string;
  size: number;
}

export interface ReleaseArtifactManifest {
  schema: 'o8/release-artifact-manifest/v1';
  createdAt: string;
  recipe: ReleaseArtifactRecipe;
  outputs: ReleaseArtifactOutput[];
}

export function collectReleaseArtifactRecipe(
  root: string,
  version: string,
  options?: { env?: NodeJS.ProcessEnv },
): ReleaseArtifactRecipe;
export function writeReleaseArtifactManifest(
  root: string,
  recipe: ReleaseArtifactRecipe,
): { manifestPath: string; manifest: ReleaseArtifactManifest };
export function verifyReleaseArtifactManifest(
  root: string,
  recipe: ReleaseArtifactRecipe,
): { reusable: boolean; reason: string; manifest?: ReleaseArtifactManifest };
