// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { O8ThreadsPane } from './O8ThreadsPane';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { TaskPoolTask } from '../repo-focus/tabs/control-room/types';

vi.mock('../orchestrator-data-context', () => ({ useOrchestratorData: () => ({ activeProjectId: 'project', agents: [], missionState: { packets: [] } }) }));
vi.mock('../repo-registry/useProjects', () => ({ useProjects: () => ({
  activeProject: { id: 'project', name: 'Project', repoPaths: ['/fixture'] },
  ledger: { projects: [{ id: 'project', name: 'Project', repoPaths: ['/fixture'] }] }, loading: false,
}) }));
vi.mock('@/lib/tauri/ipc-fetch', () => ({ ipcFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));

const repo = { id: 'fixture', name: 'Fixture', localPath: '/fixture', defaultBranch: 'main', remoteUrl: null } as RepoRegistryEntry;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('thread blocker text through actual list and detail rendering', () => {
  it.each([
    ['Needs REQUIRED_CONFIG_KEY before continuing.', 'Needs REQUIRED_CONFIG_KEY before continuing.'],
    ['Waiting for missing_env to be set.', 'Waiting for missing_env to be set.'],
    ['Review src/read_file.ts before continuing.', 'Review src/read_file.ts before continuing.'],
    ['Switch to branch feature/missing_input and retry.', 'Switch to branch feature/missing_input and retry.'],
    ['Request failed: custom_error_code', 'Request failed: custom_error_code'],
    ['Run check_health --retry_count=2.', 'Run check_health --retry_count=2.'],
    ['REQUIRED_CONFIG_KEY', 'REQUIRED_CONFIG_KEY'],
    ['workspace_unavailable', 'workspace unavailable'],
    ['stage2_waiting', 'stage2 waiting'],
    ['Waiting for operator review.', 'Waiting for operator review.'],
  ])('renders %s faithfully in the row and detail', async (blockedReason, expected) => {
    const task = { id: 'blocker', packetId: 'packet-blocker', title: 'Blocked work', summary: 'Recorded task',
      group: 'blocked', status: 'blocked', runtime: 'cloud', repoPath: '/fixture', project: { id: 'project' },
      blockedReason, lane: { sessionKey: 'cloud:blocker' }, lastEventLabel: 'awaiting_input',
    } as TaskPoolTask;
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ tasks: [task] }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => root.render(createElement(O8ThreadsPane, { active: true, repoPath: '/fixture', repos: [repo] })));
    const row = host.querySelector<HTMLButtonElement>('[aria-label="View thread Blocked work"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain(expected);
    act(() => row!.click());
    expect([...host.querySelectorAll('p')].some(node => node.textContent === expected)).toBe(true);
    expect(fetchMock.mock.calls.every(call => !call[1]?.method || call[1].method === 'GET')).toBe(true);
  });
});
