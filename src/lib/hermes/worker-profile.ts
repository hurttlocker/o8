import { assertRuntimeConfigText, copyRuntimeConfigFile } from '@/lib/providers/runtime-config';
import { assertNewRuntimeProfile } from '@/lib/providers/legacy-runtime-config';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const HERMES_WORKER_PROFILE_FILES = ['config.yaml', '.env', 'auth.json', 'models_dev_cache.json'] as const;

function operatorHermesHome(): string {
  const configured = process.env.HERMES_HOME?.trim();
  if (configured) return configured;
  const userHome = process.env.HOME?.trim() || homedir();
  return path.join(userHome, '.hermes');
}

/**
 * Give every o8-owned Hermes worker a private Hermes state home. Hermes upstream explicitly
 * warns that two agent processes must not share one profile because both write
 * memory/session state. We seed only portable config/credential files; tool
 * disable state from the governed orchestrator profile is never copied.
 */
export function prepareHermesWorkerHome(sessionDir: string): { hermesHome: string } {
  const hermesHome = path.join(sessionDir, 'hermes-home');
  assertNewRuntimeProfile(hermesHome);

  const source = operatorHermesHome();
  if (!existsSync(path.join(source, 'config.yaml'))) {
    throw new Error('Hermes worker refused: ~/.hermes/config.yaml is missing. Run `hermes setup` first.');
  }
  for (const file of HERMES_WORKER_PROFILE_FILES) {
    const from = path.join(source, file);
    if (existsSync(from)) assertRuntimeConfigText(from, readFileSync(from, 'utf8'), 'hermes');
  }

  mkdirSync(hermesHome, { recursive: true, mode: 0o700 });
  try { chmodSync(hermesHome, 0o700); } catch { /* best-effort on Windows */ }

  for (const file of HERMES_WORKER_PROFILE_FILES) {
    const from = path.join(source, file);
    if (!existsSync(from)) continue;
    const to = path.join(hermesHome, file);
    copyRuntimeConfigFile(from, to, 'hermes');
    try { chmodSync(to, 0o600); } catch { /* best-effort on Windows */ }
  }
  return { hermesHome };
}
