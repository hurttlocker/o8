export const MOBILE_SELECTED_REPO_STORAGE_KEY = 'mobile-selected-repo';

const CURRENT_PROJECT_SENTINEL = '__mobile-current-project__';

export interface MobileRepoOption {
  id: string;
  name: string;
  localPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeMobileRepoList(data: unknown): MobileRepoOption[] {
  const items = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.repos)
      ? data.repos
      : [];

  return items.reduce<MobileRepoOption[]>((acc, item) => {
    if (!isRecord(item)) return acc;

    const localPath = typeof item.localPath === 'string' && item.localPath.trim()
      ? item.localPath.trim()
      : typeof item.path === 'string' && item.path.trim()
        ? item.path.trim()
        : '';
    if (!localPath) return acc;
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : localPath;

    acc.push({
      id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name : getRepoBasename(localPath) ?? 'Repo',
      localPath,
    });

    return acc;
  }, []);
}

export function getRepoBasename(repoPath?: string | null) {
  const normalized = repoPath?.trim().replace(/[\\/]+$/, '');
  if (!normalized) return null;

  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export function getMobileRepoLabel(repoPath: string | null, repoOptions: readonly MobileRepoOption[]) {
  if (!repoPath) return 'Current project';
  const matched = repoOptions.find((repo) => repo.localPath === repoPath);
  return matched?.name?.trim() || getRepoBasename(repoPath) || 'Current project';
}

export function readStoredMobileRepoPath() {
  if (typeof window === 'undefined') return null;

  try {
    const stored = window.localStorage.getItem(MOBILE_SELECTED_REPO_STORAGE_KEY);
    if (!stored || stored === CURRENT_PROJECT_SENTINEL) return null;
    return stored;
  } catch {
    return null;
  }
}

export function writeStoredMobileRepoPath(repoPath: string | null) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(
      MOBILE_SELECTED_REPO_STORAGE_KEY,
      repoPath?.trim() || CURRENT_PROJECT_SENTINEL,
    );
  } catch {
    // Ignore local storage failures on constrained browsers.
  }
}
