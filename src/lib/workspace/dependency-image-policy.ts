export const APFS_DEPENDENCY_IMAGES_ENV = 'O8_APFS_DEPENDENCY_IMAGES';

export function resolveApfsDependencyImagesOverride(
  env: Record<string, string | undefined> = process.env,
): boolean | null {
  const value = env[APFS_DEPENDENCY_IMAGES_ENV];
  if (value === undefined) return null;
  return value === '1';
}
