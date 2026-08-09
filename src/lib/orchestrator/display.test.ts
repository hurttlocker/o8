import { describe, it, expect } from 'vitest';
import { runtimeDisplayLabel, agentDisplayLabel, orchestratorBackendDisplayLabel } from './display';

// Regression guard for the recurring "raw session id leaks into a label" bug.
// The canonical helpers MUST never emit a raw id or an owned-key prefix
// (`codex-owned:`/`codex-owned-`, `gemini-owned:`, ...). The historical leak was
// `sessionKey.split(':').pop()?.slice(0, 12)` → the literal "codex-owned-".
describe('runtimeDisplayLabel', () => {
  it('maps each runtime to its human label', () => {
    expect(runtimeDisplayLabel('codex')).toBe('Codex');
    expect(runtimeDisplayLabel('claude-code')).toBe('Claude Code');
    expect(runtimeDisplayLabel('gemini')).toBe('Gemini');
    expect(runtimeDisplayLabel('opencode')).toBe('OpenCode 2');
  });

  it('falls back to the generic "Agent" for unknown/empty runtimes — never a raw value', () => {
    expect(runtimeDisplayLabel(null)).toBe('Agent');
    expect(runtimeDisplayLabel(undefined)).toBe('Agent');
    expect(runtimeDisplayLabel('')).toBe('Agent');
    expect(runtimeDisplayLabel('something-weird')).toBe('Agent');
  });
});

describe('agentDisplayLabel', () => {
  it('prefers an explicit name, then title', () => {
    expect(agentDisplayLabel({ name: 'Fix the merge bug' })).toBe('Fix the merge bug');
    expect(agentDisplayLabel({ name: '  ', title: 'Task inline-1' })).toBe('Task inline-1');
    expect(agentDisplayLabel({ name: 'Real name', title: 'ignored' })).toBe('Real name');
  });

  it('uses a human packet title instead of a packet-shaped session id', () => {
    expect(agentDisplayLabel({
      title: 'Packet cards outcome-first UX',
      sessionKey: 'codex-owned:pkt-a3f99b36-5e4f-4acd-b006-e264389ae527',
    })).toBe('Packet cards outcome-first UX');
  });

  it('falls back to the runtime human label derived from an owned sessionKey — NEVER the raw prefix', () => {
    expect(agentDisplayLabel({ sessionKey: 'codex-owned:codex-owned-1782-abc' })).toBe('Codex');
    expect(agentDisplayLabel({ sessionKey: 'gemini-owned:gemini-owned-9-z' })).toBe('Gemini');
    expect(agentDisplayLabel({ sessionKey: 'opencode-owned:opencode-owned-3-y' })).toBe('OpenCode 2');
    expect(agentDisplayLabel({ sessionKey: 'claude-code:claude-code-x' })).toBe('Claude Code');
  });

  it('honours an explicit runtime over the sessionKey', () => {
    expect(agentDisplayLabel({ sessionKey: 'codex-owned:foo', runtime: 'gemini' })).toBe('Gemini');
  });

  it('never returns an owned-key prefix for any owned key (the leak invariant)', () => {
    for (const key of [
      'codex-owned:codex-owned-1-a',
      'gemini-owned:gemini-owned-2-b',
      'opencode-owned:opencode-owned-3-c',
      'claude-code:claude-code-4-d',
    ]) {
      const label = agentDisplayLabel({ sessionKey: key });
      expect(label).not.toMatch(/owned/i);
      expect(label).not.toContain(':');
      expect(label).not.toContain('-');
    }
  });

  it('falls back to "Agent" when nothing identifying is available', () => {
    expect(agentDisplayLabel({})).toBe('Agent');
    expect(agentDisplayLabel({ name: '', title: '  ' })).toBe('Agent');
  });
});

describe('orchestratorBackendDisplayLabel', () => {
  it('surfaces Hermes as a single runtime identity', () => {
    expect(orchestratorBackendDisplayLabel({ backend: 'hermes' })).toBe('Hermes');
  });

  it('disambiguates OpenClaw Mister agents with the agent id', () => {
    expect(orchestratorBackendDisplayLabel({ backend: 'openclaw', agent: 'main' })).toBe('OpenClaw · Mister · main');
    expect(orchestratorBackendDisplayLabel({ backend: 'openclaw', agent: 'main-public' })).toBe('OpenClaw · Mister · main-public');
    expect(orchestratorBackendDisplayLabel({ backend: 'openclaw', agent: 'mister-scribe' })).toBe('OpenClaw · Mister · mister-scribe');
  });
});
