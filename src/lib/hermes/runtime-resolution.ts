import { existsSync } from 'node:fs';

import { scanForBinary } from '@/lib/runtimes/shared/cli-locate';

/** Resolve the Hermes CLI without tying discovery to either orchestrator or worker policy. */
export function resolveHermesBinary(): string | null {
  const home = process.env.HOME?.trim() ?? '';
  for (const candidate of [
    process.env.O8_HERMES_BIN,
    home ? `${home}/.local/bin/hermes` : null,
    '/opt/homebrew/bin/hermes',
    '/usr/local/bin/hermes',
    home ? `${home}/.npm-global/bin/hermes` : null,
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return scanForBinary('hermes');
}
