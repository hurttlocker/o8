import { describe, it, expect } from 'vitest';

import { stripPluginSections } from './codex-orchestrator-session';

// Guards the env fix (2026-07-02): the worker's sandbox CODEX_HOME must be
// plugin-free, or codex re-clones/refreshes the operator's plugin marketplaces on
// every launch and starves the worker (launching -> idle -> launch_attempts_exhausted).
describe('stripPluginSections', () => {
  const config = [
    'model = "gpt-5.5"',
    '',
    '[features]',
    'web_search = true',
    '',
    '[marketplaces.openai-bundled]',
    'source = "/tmp/bundled"',
    '',
    '[marketplaces.claude-plugins-official]',
    'source = "https://github.com/anthropics/claude-plugins-official.git"',
    '',
    '[plugins."documents@openai-primary-runtime"]',
    'enabled = true',
    '',
    '[mcp_servers.o8]',
    'command = "node"',
  ].join('\n');

  it('drops every [marketplaces.*] and [plugins.*] section', () => {
    const out = stripPluginSections(config);
    expect(out).not.toContain('[marketplaces.openai-bundled]');
    expect(out).not.toContain('claude-plugins-official');
    expect(out).not.toContain('[plugins."documents@openai-primary-runtime"]');
    expect(out).not.toContain('enabled = true');
  });

  it('keeps model config, [features], and [mcp_servers.*] intact', () => {
    const out = stripPluginSections(config);
    expect(out).toContain('model = "gpt-5.5"');
    expect(out).toContain('[features]');
    expect(out).toContain('web_search = true');
    expect(out).toContain('[mcp_servers.o8]');
    expect(out).toContain('command = "node"');
  });

  it('returns empty for empty / whitespace-only input', () => {
    expect(stripPluginSections('')).toBe('');
    expect(stripPluginSections('   \n\n  ')).toBe('');
  });

  it('does not over-match a section that merely contains "plugin" elsewhere', () => {
    const out = stripPluginSections('[mcp_servers.node_repl.env]\nPLUGIN_HINT = "x"');
    expect(out).toContain('[mcp_servers.node_repl.env]');
    expect(out).toContain('PLUGIN_HINT');
  });
});
