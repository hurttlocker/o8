/**
 * Governed Hermes profile (Step 3d) — the disabled_toolsets parser + the
 * lockout invariant (pure). The live end-to-end (copy + `hermes tools disable`)
 * is exercised by tests/smoke/hermes-governed-profile-smoke.ts when hermes is
 * installed.
 */

import { describe, it, expect } from 'vitest';

import { HERMES_DENIED_TOOLSETS, parseDisabledFromToolsList } from './hermes-profile';

describe('HERMES_DENIED_TOOLSETS', () => {
  it('denies the native spawn (delegation) + the direct-work toolsets', () => {
    // delegation = Hermes's native sub-agent spawn — the #1075-critical one.
    expect(HERMES_DENIED_TOOLSETS).toContain('delegation');
    for (const t of ['terminal', 'file', 'code_execution', 'browser', 'computer_use']) {
      expect(HERMES_DENIED_TOOLSETS).toContain(t);
    }
  });
});

describe('parseDisabledFromToolsList', () => {
  // Real `hermes tools list` shape (verified against hermes v0.17.0).
  const sample = [
    'Built-in toolsets (cli):',
    '  ✓ enabled  web  🔍 Web Search & Scraping',
    '  ✗ disabled  terminal  💻 Terminal & Processes',
    '  ✗ disabled  file  📁 File Operations',
    '  ✓ enabled  memory  💾 Memory',
    '  ✗ disabled  delegation  👥 Task Delegation',
    '',
    'MCP servers:',
    '  o8  all tools enabled',
  ].join('\n');

  it('extracts exactly the ✗ disabled toolsets', () => {
    const set = parseDisabledFromToolsList(sample);
    expect(set.has('terminal')).toBe(true);
    expect(set.has('file')).toBe(true);
    expect(set.has('delegation')).toBe(true);
    expect(set.has('web')).toBe(false); // enabled
    expect(set.has('memory')).toBe(false);
    expect(set.has('o8')).toBe(false); // MCP server line, not a ✗ disabled toolset
  });

  it('empty → empty set', () => {
    expect(parseDisabledFromToolsList('Built-in toolsets (cli):\n  ✓ enabled  web  🔍\n').size).toBe(0);
  });
});
