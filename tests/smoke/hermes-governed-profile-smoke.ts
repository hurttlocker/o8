/**
 * Governed Hermes profile (Step 3d) — LIVE lockout proof. Gated on hermes being
 * installed; SKIPS otherwise. Generates the governed profile and asserts the
 * native work toolsets (delegation = native spawn, terminal/file/code_execution/
 * browser/computer_use) are denied in the ISOLATED config — never touching the
 * user's ~/.hermes.
 *
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx tests/smoke/hermes-governed-profile-smoke.ts
 */

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import './require-temp-data-dir';
import { governHermesProfile, isHermesProfileGoverned, parseDisabledFromToolsList, HERMES_DENIED_TOOLSETS } from '@/lib/lane/orchestrator-backends/hermes-profile';

function resolveHermes(): string | null {
  for (const c of [process.env.O8_HERMES_BIN, `${homedir()}/.local/bin/hermes`, '/opt/homebrew/bin/hermes', '/usr/local/bin/hermes', `${homedir()}/.npm-global/bin/hermes`]) {
    if (c && existsSync(c)) return c;
  }
  try {
    return execFileSync('command', ['-v', 'hermes'], { encoding: 'utf8', shell: '/bin/sh' } as never).trim() || null;
  } catch {
    return null;
  }
}

function main(): void {
  const bin = resolveHermes();
  if (!bin || !existsSync(join(homedir(), '.hermes', 'config.yaml'))) {
    console.log('[hermes-governed-profile-smoke] SKIPPED — hermes not installed/configured on this machine');
    return;
  }

  const governed = governHermesProfile(bin);
  assert(governed, 'governHermesProfile returns a governed home');
  assert(isHermesProfileGoverned(governed.home, bin), 'profile reports governed');

  // Authoritative check via the governed home's `hermes tools list`.
  const list = execFileSync(bin, ['tools', 'list'], { env: { ...process.env, HOME: governed.home }, encoding: 'utf8', timeout: 20000 });
  const denied = parseDisabledFromToolsList(list);
  for (const t of HERMES_DENIED_TOOLSETS) {
    assert(denied.has(t), `governed profile denies "${t}" (per hermes tools list)`);
  }
  assert(/\bo8\b/.test(list), 'o8 MCP server is retained in the governed profile');
  assert(governed.home !== homedir() && governed.home.includes('hermes-o8'), 'governed home is isolated (~/.o8/hermes-o8)');

  console.log(`[hermes-governed-profile-smoke] PASS — governed at ${governed.home}; denied: ${HERMES_DENIED_TOOLSETS.join(', ')}; o8 MCP retained`);
}

main();
