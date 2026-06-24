import { describe, it, expect } from 'vitest';
import { collapseArchivedLanesByTask, normalizeTaskLabel, type CollapsibleArchivedLane } from './collapse-archived-by-task';

const lane = (over: Partial<CollapsibleArchivedLane> & { id: string }): CollapsibleArchivedLane => ({
  label: 'Add #943 MCP-as-API proof marker doc',
  repoPath: '/repo/o8',
  sessionKey: 'codex-owned:sk-1',
  updatedAt: '2026-06-24T00:00:00.000Z',
  ...over,
});

describe('collapseArchivedLanesByTask (#1292)', () => {
  it('collapses same-task lanes to one row', () => {
    const out = collapseArchivedLanesByTask([
      lane({ id: 'l1' }),
      lane({ id: 'l2', sessionKey: 'codex-owned:sk-2' }),
      lane({ id: 'l3', sessionKey: 'codex-owned:sk-3' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('folds a "(retry N)" relaunch sibling onto its parent', () => {
    const out = collapseArchivedLanesByTask([
      lane({ id: 'l1', label: 'Add #943 MCP-as-API proof marker doc' }),
      lane({ id: 'l2', label: 'Add #943 MCP-as-API proof marker doc (retry 1)' }),
      lane({ id: 'l3', label: 'Add #943 MCP-as-API proof marker doc (retry 2)' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps the sessionKey-bearing sibling over an anonymized ghost', () => {
    const out = collapseArchivedLanesByTask([
      lane({ id: 'ghost', sessionKey: null }),
      lane({ id: 'real', sessionKey: 'codex-owned:sk-real' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('real');
  });

  it('breaks ties by most-recent updatedAt when session status matches', () => {
    const out = collapseArchivedLanesByTask([
      lane({ id: 'older', updatedAt: '2026-06-20T00:00:00.000Z' }),
      lane({ id: 'newer', updatedAt: '2026-06-24T00:00:00.000Z' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('newer');
  });

  it('does NOT collapse different tasks or different repos', () => {
    const out = collapseArchivedLanesByTask([
      lane({ id: 'a', label: 'Task A' }),
      lane({ id: 'b', label: 'Task B' }),
      lane({ id: 'c', label: 'Task A', repoPath: '/repo/other' }),
    ]);
    expect(out).toHaveLength(3);
  });

  it('normalizeTaskLabel strips the retry suffix and lowercases', () => {
    expect(normalizeTaskLabel(lane({ id: 'x', label: 'Fix It (retry 3)' }))).toBe('fix it');
    expect(normalizeTaskLabel(lane({ id: 'y', label: null, branch: 'feat/x' }))).toBe('feat/x');
  });
});
