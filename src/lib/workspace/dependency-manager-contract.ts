import type { SupportedPackageManager } from './dependency-install';

export function dependencyInstallCommandForManager(
  manager: SupportedPackageManager,
  declaredVersion: string | null,
  hasManagerLock: boolean,
): string | null {
  if (!hasManagerLock) return null;
  if (manager === 'npm') return 'npm ci --prefer-offline';
  if (manager === 'pnpm') return 'pnpm install --frozen-lockfile';
  if (manager === 'yarn') {
    return declaredVersion && !declaredVersion.startsWith('1.')
      ? 'yarn install --immutable'
      : 'yarn install --frozen-lockfile';
  }
  return 'bun install --frozen-lockfile';
}
