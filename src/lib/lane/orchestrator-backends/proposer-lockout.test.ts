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

  it('lets genuinely read-only tools through (native reads + allowlisted cortex reads)', () => {
    for (const t of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite']) {
      expect(classifyProposerTool(t)).toBe('safe');
    }
    // cortex is a MIXED surface — only the allowlisted read tools are safe.
    for (const t of [
      'mcp__cortex__cortex_ask', 'mcp__cortex__cortex_read_packets', 'mcp__cortex__cortex_read_transcript',
      'mcp__cortex__cortex_fleet_status', 'mcp__cortex__cortex_list_approvals', 'mcp__cortex__cortex_list_issues',
      'mcp__cortex__cortex_list_prs', 'mcp__cortex__cortex_list_projects', 'mcp__cortex__cortex_ci_status',
      'cortex__cortex_ask', // Codex form
    ]) {
      expect(classifyProposerTool(t)).toBe('safe');
    }
  });

  it('flags cortex MUTATORS as dispatch — the hole the review found (cortex is MIXED, not read-only memory)', () => {
    // cortex_launch_agent POSTs /api/orchestrator/delegate → dispatches a worker.
    expect(classifyProposerTool('mcp__cortex__cortex_launch_agent')).toBe('dispatch');
    expect(classifyProposerTool('cortex__cortex_launch_agent')).toBe('dispatch'); // Codex surface
    expect(classifyProposerTool('cortex_launch_agent')).toBe('dispatch'); // bare
    for (const verb of [
      'cortex_steer_agent', 'cortex_interrupt_agent', 'cortex_resolve_approval', 'cortex_update_packet',
      'cortex_propose_spec', 'cortex_create_project', 'cortex_delete_project', 'cortex_set_repo_role',
      'cortex_add_repo_to_project', 'cortex_remove_repo_from_project', 'cortex_create_project_from_suggestion',
      'cortex_dismiss_project_suggestion', 'cortex_refresh_project_suggestions', 'cortex_suggest_projects',
    ]) {
      expect(classifyProposerTool(`mcp__cortex__${verb}`)).toBe('dispatch');
      expect(classifyProposerTool(`cortex__${verb}`)).toBe('dispatch');
    }
    // The two cortex tools without a `cortex_` prefix — register_mcp (mutator)
    // and lane_touches (not allowlisted) — fail closed too.
    expect(classifyProposerTool('mcp__cortex__register_mcp')).toBe('dispatch');
    expect(classifyProposerTool('mcp__cortex__lane_touches')).toBe('dispatch');
  });

  it('fails closed on UNKNOWN cortex tools (a tool added later must opt in, not fall through)', () => {
    expect(classifyProposerTool('mcp__cortex__cortex_some_future_mutator')).toBe('dispatch');
    expect(classifyProposerTool('cortex__cortex_brand_new_thing')).toBe('dispatch');
    expect(classifyProposerTool('cortex_anything_not_allowlisted')).toBe('dispatch');
  });

  it('flags EXTERNAL MCP server tools as dispatch — proposers get NO external servers', () => {
    // The propose profile strips every external server, so any mcp__<server>__*
    // that isn't operator/cortex is a leak → fail closed (belt-and-suspenders).
    for (const t of [
      'mcp__postgres__execute_sql', 'mcp__github__create_issue', 'mcp__linear__create_issue',
      'mcp__slack__post_message', 'mcp__filesystem__write_file', 'mcp__some_unknown_server__any_tool',
    ]) {
      expect(classifyProposerTool(t)).toBe('dispatch');
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
