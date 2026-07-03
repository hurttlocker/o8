/**
 * Fable Slice 1 — Layer B (native-tool lockout) + BYO-key injection guards.
 *
 * Models the proposer-lockout tests: assert the arg-builder emits the lockout
 * flags and the BYO-key injection is Fable-scoped. The EMPIRICAL proof that these
 * flags actually block `Read` in the live REPL is the standalone probe (see the
 * report) — this suite pins the flags the probe verified. The Layer A MCP-surface
 * projection (`buildToolRegistry(profile:'fable')`) is asserted in the tsx smoke
 * `tests/smoke/proposer-profile-lockout-smoke.ts` (buildToolRegistry needs the
 * real DB harness + `@/` runtime-require resolution, which vitest can't provide).
 */

import { describe, it, expect } from 'vitest';

import { fableLockoutArgs, fableEnvOverride, FABLE_DISALLOWED_TOOLS, FABLE_DISALLOWED_MCP_TOOLS } from './fable-profile';
import { FABLE_API_KEY_ENV } from './orchestrator-backends/fable-config';

describe('fableLockoutArgs — Layer B native-tool lockout', () => {
  it('keeps --dangerously-skip-permissions AND emits a --disallowedTools deny rule', () => {
    const args = fableLockoutArgs();
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--disallowedTools');
  });

  it('denies the native context/write/exec tools — Read (the token lever) included', () => {
    const denied = fableLockoutArgs().slice(fableLockoutArgs().indexOf('--disallowedTools') + 1);
    for (const t of ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task']) {
      expect(denied).toContain(t);
    }
    // MultiEdit is not a known tool in the shipped CLI — omitted to avoid a warning.
    expect(denied).not.toContain('MultiEdit');
  });

  it('emits each disallowed tool as its own argv element (variadic-flag contract)', () => {
    const args = fableLockoutArgs();
    expect(args.slice(args.indexOf('--disallowedTools') + 1)).toEqual([
      ...FABLE_DISALLOWED_TOOLS,
      ...FABLE_DISALLOWED_MCP_TOOLS,
    ]);
  });

  it('Slice 3 — denies the raw-transcript MCP tools (compact-return enforcement)', () => {
    const denied = fableLockoutArgs().slice(fableLockoutArgs().indexOf('--disallowedTools') + 1);
    // The two raw-bulk holes on the kept servers: a worker's full codex
    // transcript must never enter the metered window — hand-backs go through
    // the ~1.2KB PacketContext / get_mission_status summary instead.
    expect(denied).toContain('mcp__operator__o8_packet_transcript');
    expect(denied).toContain('mcp__cortex__cortex_read_transcript');
    // The user-scope "o8" aliases (live dogfood hole, 2026-07-02).
    expect(denied).toContain('mcp__o8__o8_packet_transcript');
    // mission_tail stays: compact lane events (audit stream), not transcript.
    expect(denied.some((t) => t.includes('mission_tail'))).toBe(false);
  });

  it('forces a hermetic MCP surface (--strict-mcp-config) so user-scope servers cannot merge in', () => {
    expect(fableLockoutArgs()).toContain('--strict-mcp-config');
  });

  it('NEVER emits -p / --print (subscription-billing guard)', () => {
    const args = fableLockoutArgs();
    expect(args).not.toContain('-p');
    expect(args).not.toContain('--print');
  });
});

describe('fableEnvOverride — BYO key injection, Fable-scoped only', () => {
  it('clears DISABLE_PROMPT_CACHING but injects no key when the BYO env is unset', () => {
    const prev = process.env[FABLE_API_KEY_ENV];
    delete process.env[FABLE_API_KEY_ENV];
    try {
      expect(fableEnvOverride()).toEqual({ DISABLE_PROMPT_CACHING: '' });
    } finally {
      if (prev !== undefined) process.env[FABLE_API_KEY_ENV] = prev;
    }
  });

  it('maps the BYO key onto ANTHROPIC_API_KEY AND force-clears DISABLE_PROMPT_CACHING (metered procs must always cache)', () => {
    const prev = process.env[FABLE_API_KEY_ENV];
    process.env[FABLE_API_KEY_ENV] = 'sk-ant-byo-test';
    try {
      expect(fableEnvOverride()).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-byo-test', DISABLE_PROMPT_CACHING: '' });
    } finally {
      if (prev === undefined) delete process.env[FABLE_API_KEY_ENV];
      else process.env[FABLE_API_KEY_ENV] = prev;
    }
  });
});
