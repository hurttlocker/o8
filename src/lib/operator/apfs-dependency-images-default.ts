export interface ApfsDependencyImagesDefaults {
  /** Reuse eligible dependency installs through APFS disk images. */
  apfsDependencyImages: boolean;
}

export function defaultApfsDependencyImages(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin';
}

export const APFS_DEPENDENCY_IMAGES_FALLBACK: ApfsDependencyImagesDefaults = {
  apfsDependencyImages: defaultApfsDependencyImages(),
};

export function resolveStoredApfsDependencyImages(
  stored: Partial<ApfsDependencyImagesDefaults>,
): Partial<ApfsDependencyImagesDefaults> {
  return typeof stored.apfsDependencyImages === 'boolean'
    ? { apfsDependencyImages: stored.apfsDependencyImages }
    : {};
}

export function applyApfsDependencyImagesUpdate(
  stored: Partial<ApfsDependencyImagesDefaults>,
  update: Partial<ApfsDependencyImagesDefaults>,
): void {
  if (update.apfsDependencyImages !== undefined) {
    stored.apfsDependencyImages = Boolean(update.apfsDependencyImages);
  }
}
