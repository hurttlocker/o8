import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveHermesBinary } from '@/lib/hermes/runtime-resolution';
import type { RuntimeAuthStatus } from './auth-detect';

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function hermesReadiness(): Promise<Omit<RuntimeAuthStatus, 'house' | 'runtime' | 'checkedAt' | 'ready' | 'unavailableReason'> & { ready?: boolean; unavailableReason?: RuntimeAuthStatus['unavailableReason'] }> {
  const binaryPath = resolveHermesBinary() ?? undefined;
  if (!binaryPath) {
    return {
      installed: false,
      authenticated: false,
      detail: 'Hermes CLI is not installed.',
      fix: 'Install Hermes Agent, then run `hermes setup`.',
    };
  }

  const hermesHome = process.env.HERMES_HOME?.trim() || path.join(process.env.HOME?.trim() || os.homedir(), '.hermes');
  const configured = await fileExists(path.join(hermesHome, 'config.yaml'));
  if (!configured) {
    return {
      installed: true,
      authenticated: false,
      ready: false,
      unavailableReason: 'needs_auth',
      detail: 'Hermes CLI is installed but no configured ~/.hermes/config.yaml profile was found.',
      fix: 'Run `hermes setup` before dispatching Hermes workers.',
      binaryPath,
    };
  }

  const authenticated = Boolean(
    process.env.OPENROUTER_API_KEY?.trim()
    || process.env.NOUS_API_KEY?.trim()
    || process.env.OPENAI_API_KEY?.trim()
    || process.env.ANTHROPIC_API_KEY?.trim()
    || process.env.DEEPSEEK_API_KEY?.trim()
    || process.env.GEMINI_API_KEY?.trim(),
  ) || await fileExists(path.join(hermesHome, '.env'))
    || await fileExists(path.join(hermesHome, 'auth.json'));

  return {
    installed: true,
    authenticated,
    ready: true,
    unavailableReason: null,
    detail: authenticated
      ? 'Hermes is configured and has local provider credential evidence.'
      : 'Hermes is configured; provider auth may be runtime-owned or keyless/local and is validated by Hermes at turn start.',
    fix: 'No action needed.',
    binaryPath,
  };
}
