import { chmodSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const HERMES_WORKER_PROFILE_FILES = ['config.yaml', '.env', 'auth.json', 'models_dev_cache.json'] as const;

function operatorHermesHome(): string {
  const userHome = process.env.HOME?.trim() || homedir();
  return path.join(userHome, '.hermes');
}

/**
 * Give every o8-owned Hermes worker a private HOME. Hermes upstream explicitly
 * warns that two agent processes must not share one profile because both write
 * memory/session state. We seed only portable config/credential files; tool
 * disable state from the governed orchestrator profile is never copied.
 */
export function prepareHermesWorkerHome(sessionDir: string): { home: string } {
  const source = operatorHermesHome();
  if (!existsSync(path.join(source, 'config.yaml'))) {
    throw new Error('Hermes worker refused: ~/.hermes/config.yaml is missing. Run `hermes setup` first.');
  }

  const home = path.join(sessionDir, 'home');
  const target = path.join(home, '.hermes');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  try { chmodSync(home, 0o700); } catch { /* best-effort on Windows */ }
  try { chmodSync(target, 0o700); } catch { /* best-effort on Windows */ }

  for (const file of HERMES_WORKER_PROFILE_FILES) {
    const from = path.join(source, file);
    if (!existsSync(from)) continue;
    const to = path.join(target, file);
    cpSync(from, to);
    try { chmodSync(to, 0o600); } catch { /* best-effort on Windows */ }
  }
  return { home };
}
