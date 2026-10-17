export type CliUpdateStage = 'checking' | 'installing' | 'verifying' | 'succeeded' | 'failed';
export interface CliUpdateProgress { stage: CliUpdateStage; startedAt: number; updatedAt: number; message?: string }
export type CliUpdateReporter = (stage: CliUpdateStage) => void;

export const CLI_UPDATE_VERSION_PATTERN = /(?<![\d.])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/;

/** A complete version token preserves prerelease ordering used by CLI channels. */
export function parseUpdateVersion(value: string | undefined): string | null {
  return value?.match(CLI_UPDATE_VERSION_PATTERN)?.[1] ?? null;
}
export function compareUpdateVersions(left: string, right: string): number {
  const [a, ap] = left.split('-', 2); const [b, bp] = right.split('-', 2);
  const av = a!.split('.').map(Number); const bv = b!.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const diff = av[i]! - bv[i]!; if (diff) return diff; }
  if (!ap || !bp) return ap === bp ? 0 : ap ? -1 : 1;
  return left.slice(a!.length + 1).localeCompare(right.slice(b!.length + 1), undefined, { numeric: true });
}
