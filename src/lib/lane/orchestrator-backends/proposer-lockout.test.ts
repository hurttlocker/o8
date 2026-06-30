/**
 * Proposer read-only lockout — the regression guard (Collide Step 9d, pulled
 * forward to the Step-2 checkpoint). The single most important safety test in
 * Collide: a proposer emitting ANY write or dispatch `tool_use` is a HARD ERROR.
 * If this is green, the read-only proposer cannot act even if layers 1-2
 * (toolProfile:'propose' + permissionMode:'plan') ever regress.
 */

import { describe, it, expect } from 'vitest';

import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { assertProposerEventAllowed, classifyProposerTool, ProposerLockoutError } from './proposer-lockout';

describe('classifyProposerTool', () => {
  it('flags Claude native writes/execute as write', () => {
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']) {
      expect(classifyProposerTool(t)).toBe('write');
    }
  });

  it('flags Codex shell / apply_patch as write', () => {
    for (const t of ['shell', 'local_shell', 'apply_patch']) {
      expect(classifyProposerTool(t)).toBe('write');
    }
  });

  it('flags dispatch — the whole operator namespace + bare verbs', () => {
    expect(classifyProposerTool('mcp__operator__dispatch_mission')).toBe('dispatch');
    // operator server is stripped entirely for a proposer — even a read verb is a breach.
    expect(classifyProposerTool('mcp__operator__o8_status')).toBe('dispatch');
    expect(classifyProposerTool('dispatch_mission')).toBe('dispatch');
    expect(classifyProposerTool('create_mission')).toBe('dispatch');
    expect(classifyProposerTool('approve_and_merge')).toBe('dispatch');
    expect(classifyProposerTool('steer_packet')).toBe('dispatch');
  });

  it('lets read-only tools through (proposers may read + use cortex)', () => {
    for (const t of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite', 'mcp__cortex__cortex_ask']) {
      expect(classifyProposerTool(t)).toBe('safe');
    }
  });
});

describe('assertProposerEventAllowed — the lockout regression guard (9d)', () => {
  const text: OrchestratorEvent = { type: 'text', text: 'my independent proposal' };
  const thinking: OrchestratorEvent = { type: 'thinking', text: 'considering…' };
  const readTool: OrchestratorEvent = { type: 'tool_use', id: '1', name: 'Read', input: { path: 'x' } };
  const result: OrchestratorEvent = { type: 'tool_result', id: '1', name: 'Read', output: 'contents' };
  const done: OrchestratorEvent = { type: 'done', sessionId: 's', cost: null };

  it('passes safe events (text, thinking, read tools, result, done)', () => {
    for (const e of [text, thinking, readTool, result, done]) {
      expect(() => assertProposerEventAllowed(e, 'Claude')).not.toThrow();
    }
  });

  it('HARD ERROR on a write tool_use (Claude Write)', () => {
    const write: OrchestratorEvent = { type: 'tool_use', id: '2', name: 'Write', input: { path: 'a.ts' } };
    expect(() => assertProposerEventAllowed(write, 'Claude')).toThrow(ProposerLockoutError);
  });

  it('HARD ERROR on a write tool_use (Codex shell)', () => {
    const shell: OrchestratorEvent = { type: 'tool_use', id: '3', name: 'shell', input: { command: 'touch x' } };
    expect(() => assertProposerEventAllowed(shell, 'Codex')).toThrow(/read-only/);
  });

  it('HARD ERROR on a dispatch tool_use (mcp__operator__dispatch_mission)', () => {
    const dispatch: OrchestratorEvent = { type: 'tool_use', id: '4', name: 'mcp__operator__dispatch_mission', input: {} };
    let thrown: unknown;
    try {
      assertProposerEventAllowed(dispatch, 'Codex');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProposerLockoutError);
    expect((thrown as ProposerLockoutError).toolClass).toBe('dispatch');
  });
});
