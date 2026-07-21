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

import './require-temp-data-dir';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { toClaudeServersMap } from '@/lib/mcp/tool-spine/emit-claude';
import { toCodexServersMap } from '@/lib/mcp/tool-spine/emit-codex';
import { insertExternalMcpServer } from '@/lib/mcp/external-servers';

function main(): void {
  const repo = process.cwd();

  // Seed a user external MCP server — it must ride the FULL orchestrator surface
  // but be STRIPPED from the propose (proposer) profile on both surfaces.
  insertExternalMcpServer({ name: 'smoke-ext', transport: 'stdio', command: 'echo', args: ['hi'], enabled: true });

  const full = buildToolRegistry(repo);
  const propose = buildToolRegistry(repo, { profile: 'propose' });
  const solo = buildToolRegistry(repo, { profile: 'solo' });

  // ── External strip — present in full, ABSENT in propose, on BOTH surfaces.
  const claudeFullMap = toClaudeServersMap(full);
  const codexFullMap = toCodexServersMap(full);
  assert('smoke-ext' in claudeFullMap, 'Claude FULL config HAS the external server');
  assert('smoke-ext' in codexFullMap, 'Codex FULL config HAS the external server');
  assert(!('smoke-ext' in toClaudeServersMap(propose)), 'Claude propose config has NO external server');
  assert(!('smoke-ext' in toCodexServersMap(propose)), 'Codex propose config has NO external server');
  assert(propose.entries.every((e) => e.source !== 'external'), 'propose registry has ZERO external entries');

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

  // ── cortex is MIXED — the propose profile relaunches it READ-ONLY on BOTH
  //    surfaces (CORTEX_READONLY=1), so the dispatch/mutator tools (launch_agent,
  //    steer_agent, …) never reach the proposer's MCP config. Full profile must
  //    NOT carry the flag (byte-identical).
  const cortexEnv = (m: Record<string, unknown>): Record<string, string> => {
    const c = m.cortex as { env?: Record<string, string> } | undefined;
    return c?.env ?? {};
  };
  assert(cortexEnv(claudePropose).CORTEX_READONLY === '1', 'Claude propose cortex is CORTEX_READONLY=1');
  assert(cortexEnv(codexPropose).CORTEX_READONLY === '1', 'Codex propose cortex is CORTEX_READONLY=1');
  assert(cortexEnv(claudeFull).CORTEX_READONLY === undefined, 'Claude FULL cortex has NO read-only flag');
  assert(cortexEnv(codexFull).CORTEX_READONLY === undefined, 'Codex FULL cortex has NO read-only flag');

  // Solo keeps native repo tools in the runtime, but its MCP projection has no
  // operator dispatch server, no external tools, and read-only cortex memory.
  const soloIds = new Set(solo.entries.map((e) => e.id));
  const claudeSolo = toClaudeServersMap(solo);
  const codexSolo = toCodexServersMap(solo);
  assert(!soloIds.has('builtin:operator'), 'solo MUST NOT have operator (dispatch lockout)');
  assert(soloIds.has('builtin:cortex'), 'solo KEEPS cortex (read-only memory)');
  assert(solo.entries.every((e) => e.source !== 'external'), 'solo registry has ZERO external entries');
  assert(cortexEnv(claudeSolo).CORTEX_READONLY === '1', 'Claude solo cortex is CORTEX_READONLY=1');
  assert(cortexEnv(codexSolo).CORTEX_READONLY === '1', 'Codex solo cortex is CORTEX_READONLY=1');

  // ── FABLE profile (Slice 1) — KEEPS operator (Fable still dispatches) + cortex
  //    (ask), STRIPS externals; cortex stays at FULL read (CORTEX_READONLY is a
  //    propose-only tightening). Fable's real lockout is Layer B (native tools
  //    disallowed at the CLI — see fable-profile.ts), not the MCP surface.
  const fable = buildToolRegistry(repo, { profile: 'fable' });
  const fableIds = new Set(fable.entries.map((e) => e.id));
  assert(fableIds.has('builtin:operator'), 'fable KEEPS operator (still dispatches)');
  assert(fableIds.has('builtin:cortex'), 'fable KEEPS cortex (ask)');
  assert(fable.entries.every((e) => e.source !== 'external'), 'fable registry has ZERO external entries');

  const claudeFable = toClaudeServersMap(fable);
  assert('operator' in claudeFable, 'Claude fable config HAS operator server');
  assert('cortex' in claudeFable, 'Claude fable config HAS cortex server');
  assert(!('smoke-ext' in claudeFable), 'Claude fable config has NO external server');
  assert(cortexEnv(claudeFable).CORTEX_READONLY === undefined, 'fable cortex is FULL read (no CORTEX_READONLY)');

  // ── Zero behavior change — profile:'full' is byte-identical to the no-arg call.
  assert.deepStrictEqual(
    buildToolRegistry(repo, { profile: 'full' }),
    full,
    "buildToolRegistry(repo, { profile: 'full' }) === buildToolRegistry(repo)",
  );

  console.log(
    '[proposer-profile-lockout-smoke] PASS — propose + solo strip operator (Claude+Codex), keep cortex read-only; '
      + 'fable keeps operator+cortex + strips externals (cortex full read); '
      + 'full byte-identical to no-arg',
  );
}

main();
