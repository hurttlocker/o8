import { existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { safeJoinReal } from '@/lib/fs/safe-path';

export const ABSOLUTE_PATH_NOT_ALLOWLISTED = 'absolute_path_not_allowlisted';

export interface QuickDocEntry {
  label: string;
  value: string;
  path: string;
}

export interface QuickDocGroup {
  label: 'Global' | 'This repo';
  entries: QuickDocEntry[];
}

const GLOBAL_DOCS: Array<{ label: string; value: string; parts: string[] }> = [
  { label: 'Global CLAUDE.md', value: '~/.claude/CLAUDE.md', parts: ['.claude', 'CLAUDE.md'] },
  { label: 'Home CLAUDE.md', value: '~/CLAUDE.md', parts: ['CLAUDE.md'] },
  { label: 'Codex AGENTS.md', value: '~/.codex/AGENTS.md', parts: ['.codex', 'AGENTS.md'] },
];

const REPO_DOCS = ['CLAUDE.md', 'AGENTS.md'] as const;

export function operatorConfigAllowlist(): string[] {
  const home = homedir();
  return GLOBAL_DOCS.map((entry) => resolve(home, ...entry.parts));
}

export function resolveAllowedOperatorConfigPath(filePath: string): string | null {
  if (!isAbsolute(filePath)) return null;
  const resolved = resolve(filePath);
  if (!operatorConfigAllowlist().includes(resolved)) return null;

  try {
    if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) return null;
  } catch {
    return null;
  }

  const home = homedir();
  return safeJoinReal(home, relative(home, resolved), { allowMissing: true });
}

export function resolveRepoRelativeFilePath(root: string, filePath: string): string | null {
  if (isAbsolute(filePath)) return null;
  return safeJoinReal(root, filePath, { allowMissing: true });
}

export function buildQuickDocs(repoRoot?: string | null): { groups: QuickDocGroup[] } {
  const globalEntries = GLOBAL_DOCS.map((entry) => {
    const path = resolve(homedir(), ...entry.parts);
    return {
      label: entry.label,
      value: entry.value,
      path,
    };
  }).filter((entry) => existsSync(entry.path));

  const repoEntries: QuickDocEntry[] = repoRoot ? REPO_DOCS.map((fileName) => {
    const resolved = resolveRepoRelativeFilePath(repoRoot, fileName);
    if (!resolved || !existsSync(resolved)) return null;
    const entry: QuickDocEntry = { label: fileName, value: fileName, path: fileName };
    return entry;
  }).filter((entry): entry is QuickDocEntry => entry !== null) : [];

  const groups: QuickDocGroup[] = [
    { label: 'Global', entries: globalEntries },
    { label: 'This repo', entries: repoEntries },
  ];

  return {
    groups: groups.filter((group) => group.entries.length > 0),
  };
}
