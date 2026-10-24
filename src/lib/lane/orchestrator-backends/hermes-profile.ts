import { childEnvironment } from '@/lib/providers/spawn-environment';
import { copyRuntimeConfigFile } from '@/lib/providers/runtime-config';
import { assertRuntimeProfilesAvailable } from '@/lib/providers/legacy-runtime-config';
import { providerSpawnEnvironment } from '@/lib/providers/spawn-environment';
/**
 * Governed Hermes profile — the #1075 orchestrator≠worker lockout for Hermes.
 *
 * As an ACP CLIENT, o8 can't strip a Hermes agent's native tools the way it
 * rewrites ~/.openclaw-o8 for OpenClaw. So o8 runs `hermes acp` against an
 * ISOLATED Hermes home (~/.o8/hermes-o8) whose config DENIES Hermes's native
 * work toolsets — most importantly `delegation` (Hermes's native sub-agent
 * spawn, the direct analogue of openclaw's `sessions_spawn`), plus terminal /
 * file / code_execution / browser / computer_use. With those denied, the only
 * way the Hermes orchestrator can do work is the o8 MCP server (dispatch a Codex
 * worker through o8) — a STRUCTURAL lockout, not prompt-framing.
 *
 * Isolation is via HOME (Hermes reads $HOME/.hermes). The operator's own config
 * + account credentials seed new files with provider API keys omitted. Existing
 * profile files are left unchanged; file-based API billing belongs to #4340.
 */

import { execFileSync } from '@/lib/providers/child-process';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

/** Hermes built-in toolsets that let the agent do work DIRECTLY — denied so the
 *  orchestrator can only dispatch through o8. `delegation` is the native spawn. */
export const HERMES_DENIED_TOOLSETS = ['delegation', 'terminal', 'file', 'code_execution', 'browser', 'computer_use'];

function o8DataDir(): string {
  return getDataDir();
}

function userHermesDir(): string {
  return join(homedir(), '.hermes');
}

/** The isolated governed Hermes home — `hermes acp` runs with HOME set here. */
export function governedHermesHome(): string {
  return join(o8DataDir(), 'hermes-o8');
}

/**
 * Generate (or refresh) the governed Hermes profile. Returns the HOME to launch
 * `hermes acp` against, or null when Hermes isn't configured on this machine
 * (no ~/.hermes/config.yaml) or the governance step fails — in which case the
 * caller MUST refuse to run Hermes (never fall back to the ungoverned profile).
 */
export function governHermesProfile(hermesBin: string): { home: string } | null {
  const userDir = userHermesDir();
  const home = governedHermesHome();
  const governedHermes = join(home, '.hermes');
  // Governance changes tool state. Never run its mutating CLI through a link
  // into an operator profile, even when that profile is otherwise launchable.
  if ([home, governedHermes].some(dir => existsSync(dir) && !lstatSync(dir).isDirectory())) return null;
  assertRuntimeProfilesAvailable([governedHermes]);
  if (!existsSync(join(governedHermes, 'config.yaml')) && !existsSync(join(userDir, 'config.yaml'))) return null;
  mkdirSync(governedHermes, { recursive: true });

  // Seed once; provider API credentials never enter the new files.
  if (!existsSync(join(governedHermes, 'config.yaml'))) {
    for (const file of ['config.yaml', '.env', 'auth.json', 'models_dev_cache.json']) {
      const src = join(userDir, file);
      if (existsSync(src)) copyRuntimeConfigFile(src, join(governedHermes, file), 'hermes');
    }
  }

  // Apply the deny via Hermes's own CLI against the ISOLATED home — never touches
  // the user's ~/.hermes. (Hermes persists the disabled state internally, not in
  // config.yaml's `disabled_toolsets`, so we verify via `hermes tools list`.)
  try {
    execFileSync(hermesBin, ['tools', 'disable', ...HERMES_DENIED_TOOLSETS], {
      windowsHide: true,
      env: providerSpawnEnvironment(childEnvironment({ runtimeId: 'hermes', env: { HOME: home, HERMES_HOME: governedHermes } }), { runtimeId: 'hermes' }),
      stdio: 'ignore',
      timeout: 20000,
    });
  } catch {
    return null; // governance couldn't be applied → caller refuses to run
  }

  // Verify the lockout actually landed (authoritatively) before declaring governed.
  if (!isHermesProfileGoverned(home, hermesBin)) return null;
  return { home };
}

/**
 * True iff the governed home denies EVERY native work toolset, per Hermes's own
 * authoritative `hermes tools list` (run HOME-isolated). We trust the agent's
 * view rather than parsing config.yaml — Hermes stores the disabled state
 * internally, not under `disabled_toolsets`.
 */
export function isHermesProfileGoverned(home: string, hermesBin: string): boolean {
  if (!existsSync(join(home, '.hermes', 'config.yaml'))) return false;
  try {
    const out = execFileSync(hermesBin, ['tools', 'list'], {
      windowsHide: true,
      env: providerSpawnEnvironment(childEnvironment({ runtimeId: 'hermes', env: { HOME: home, HERMES_HOME: join(home, '.hermes') } }), { runtimeId: 'hermes' }),
      encoding: 'utf8',
      timeout: 20000,
    });
    const disabled = parseDisabledFromToolsList(out);
    return HERMES_DENIED_TOOLSETS.every((t) => disabled.has(t));
  } catch {
    return false;
  }
}

/** Parse the disabled toolset names from `hermes tools list` output
 *  (lines like `  ✗ disabled  terminal  💻 Terminal & Processes`). */
export function parseDisabledFromToolsList(output: string): Set<string> {
  const out = new Set<string>();
  for (const line of output.split('\n')) {
    const m = line.match(/✗\s+disabled\s+(\S+)/);
    if (m) out.add(m[1]);
  }
  return out;
}
