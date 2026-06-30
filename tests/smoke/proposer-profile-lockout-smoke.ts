/**
 * Collide Step 2 — DISPATCH-lockout proof against the REAL buildToolRegistry.
 *
 * The propose profile must strip the operator (dispatch) server while keeping
 * cortex (read-only memory), through BOTH orchestrator emitters (Claude JSON +
 * Codex TOML map) — so a proposer physically cannot call dispatch_mission. Also
 * asserts the full profile is byte-identical to the legacy no-arg call (zero
 * behavior change to every existing consumer).
 *
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx tests/smoke/proposer-profile-lockout-smoke.ts
 */

import assert from 'node:assert';

import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { toClaudeServersMap } from '@/lib/mcp/tool-spine/emit-claude';
import { toCodexServersMap } from '@/lib/mcp/tool-spine/emit-codex';

function main(): void {
  const repo = process.cwd();

  const full = buildToolRegistry(repo);
  const propose = buildToolRegistry(repo, { profile: 'propose' });

  // ── Entry level — operator present in full, ABSENT in propose; cortex in both.
  const fullIds = new Set(full.entries.map((e) => e.id));
  const proposeIds = new Set(propose.entries.map((e) => e.id));
  assert(fullIds.has('builtin:operator'), 'full profile HAS operator');
  assert(fullIds.has('builtin:cortex'), 'full profile HAS cortex');
  assert(!proposeIds.has('builtin:operator'), 'propose MUST NOT have operator (dispatch lockout)');
  assert(proposeIds.has('builtin:cortex'), 'propose KEEPS cortex (read-only memory)');

  // ── Projected Claude config (what ensureMcpConfig writes) — no operator key.
  const claudePropose = toClaudeServersMap(propose);
  const claudeFull = toClaudeServersMap(full);
  assert('operator' in claudeFull, 'Claude full config HAS operator server');
  assert(!('operator' in claudePropose), 'Claude propose config has NO operator server');
  assert('cortex' in claudePropose, 'Claude propose config HAS cortex');

  // ── Projected Codex config (what ensureCodexHome merges) — no operator key.
  const codexPropose = toCodexServersMap(propose);
  const codexFull = toCodexServersMap(full);
  assert('operator' in codexFull, 'Codex full config HAS operator server');
  assert(!('operator' in codexPropose), 'Codex propose config has NO operator server');
  assert('cortex' in codexPropose, 'Codex propose config HAS cortex');

  // ── Zero behavior change — profile:'full' is byte-identical to the no-arg call.
  assert.deepStrictEqual(
    buildToolRegistry(repo, { profile: 'full' }),
    full,
    "buildToolRegistry(repo, { profile: 'full' }) === buildToolRegistry(repo)",
  );

  console.log(
    '[proposer-profile-lockout-smoke] PASS — propose strips operator (Claude+Codex), keeps cortex; '
      + 'full byte-identical to no-arg',
  );
}

main();
