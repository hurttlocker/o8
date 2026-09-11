// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPanelExtraAgents, type LaneSummary } from './AgentPanelExtraAgents';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function lane(id: string, label: string): LaneSummary {
  return {
    id,
    label,
    repoPath: '/repos/project-repo',
    branch: `issue/${id}`,
    runtime: 'codex',
    sessionKey: `codex-owned:${id}`,
    packetId: `pkt-${id}`,
    status: 'running',
    ownership: 'managed',
    lastEventAt: new Date().toISOString(),
    lastEventLabel: 'agent_progress',
  };
}

const LANES = [lane('lane-a', 'Fix the agent rail'), lane('lane-b', 'Rename me later')];

describe('Agents rail row semantics (#2146)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/api/lanes') ? { lanes: LANES } : {};
      return { ok: true, json: async () => body } as unknown as Response;
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(AgentPanelExtraAgents, {
        activeSessionKey: 'codex-owned:lane-b',
        packets: [],
      }));
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('groups the rows as a labelled list so AT can announce position', () => {
    const list = container.querySelector('[role="list"]');
    expect(list).not.toBeNull();
    expect(list?.getAttribute('aria-label')).toBe('Agents');
    expect(list!.querySelectorAll('[role="listitem"]')).toHaveLength(LANES.length);
  });

  it('carries a stable per-row handle derived from the lane id, not the label', () => {
    const handles = Array.from(container.querySelectorAll<HTMLElement>('[data-o8-agent-row]'))
      .map((row) => row.dataset.o8AgentRow);
    expect(handles).toEqual(expect.arrayContaining(['lane:lane-a', 'lane:lane-b']));
    expect(handles).toHaveLength(LANES.length);
    // Every row handle sits inside a listitem — the list is not just a wrapper.
    for (const row of container.querySelectorAll('[data-o8-agent-row]')) {
      expect(row.closest('[role="listitem"]')).not.toBeNull();
    }
  });

  it('marks the open agent with aria-current', () => {
    const current = container.querySelector<HTMLElement>('[data-o8-agent-row="lane:lane-b"]');
    expect(current?.getAttribute('aria-current')).toBe('true');
    expect(
      container.querySelector('[data-o8-agent-row="lane:lane-a"]')?.getAttribute('aria-current'),
    ).toBeNull();
  });
});
