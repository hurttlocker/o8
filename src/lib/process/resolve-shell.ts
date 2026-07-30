import { existsSync } from 'node:fs';

const FALLBACK_SHELLS = ['/bin/zsh', '/bin/bash', '/bin/sh'] as const;

export function resolveShell(
  configuredShell: string | undefined = process.env.SHELL,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const candidates = configuredShell
    ? [configuredShell, ...FALLBACK_SHELLS]
    : [...FALLBACK_SHELLS];

  for (const candidate of candidates) {
    if (pathExists(candidate)) return candidate;
  }

  return '/bin/sh';
}
