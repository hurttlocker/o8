export function prunePackagedBuildInputs(serverRoot: string, platform?: string): {
  removedFiles: number;
  removedBytes: number;
};
