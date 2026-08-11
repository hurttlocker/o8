export const POSTSHIP_GENERATED_DIRS: string[];

export interface PostshipCleanupResult {
  removed: string[];
  skipped: string[];
  refused: Array<{ path: string; reason: string }>;
}

export function cleanupPostshipOutputs(repoRoot?: string): Promise<PostshipCleanupResult>;
