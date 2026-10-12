export function assertMacPackageSize(appPath: string, archivePath?: string, options?: { releaseVersion?: string }): {
  appBundleBytes: number;
  updaterArchiveBytes: number;
  allowance: string | null;
};
