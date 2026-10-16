import { expect, it, vi } from 'vitest';
import { workspaceUtilityTab } from './workspace-utility-navigation';
import { computeInspectorTab } from '../workspace-terminal/terminal-session-ops';
import { serializeTabsForPersistence } from '../workspace-terminal/terminal-tab-handlers';
import { computeRestoredTabs } from '../workspace-terminal/terminal-restore';
import type { TerminalTab } from '../workspace-terminal/types';

it('opens utility tabs through the normal workspace path, deduplicates them, and restores their project scope', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ threads: [], packets: [] })));
  try {
    const current = [{ id: 'current-chat', label: 'Current chat', kind: 'orchestrator', tmuxSession: null, createdAt: 1, lastActivity: 1 }] as TerminalTab[];
    const tabs = [...current];
    for (const kind of ['automations', 'plugins', 'customize'] as const) {
      const requested = workspaceUtilityTab(kind, 'project-a');
      const opened = computeInspectorTab(requested, tabs);
      expect(opened.newTab?.canvasTab).toEqual(requested);
      expect(opened.activeTabId).toBe(opened.newTab?.id);
      tabs.push(opened.newTab!);
      const again = computeInspectorTab(requested, tabs);
      expect(again.newTab).toBeNull();
      expect(again.updatedTabId).toBe(opened.newTab!.id);
      expect(again.activeTabId).toBe(opened.newTab!.id);
    }
    expect(tabs[0]).toBe(current[0]);
    const saved = serializeTabsForPersistence(tabs.slice(1));
    const result = await computeRestoredTabs({ version: 1, activeTabId: tabs[3].id, tabs: saved, savedAt: new Date(0).toISOString() }, { preferredRepo: null, defaultTab: 'terminal', createDefaultChatTab: () => current[0] });
    expect(result?.tabs.map((tab) => tab.canvasTab)).toEqual(tabs.slice(1).map((tab) => tab.canvasTab));
    expect(workspaceUtilityTab('plugins', 'project-b').id).not.toBe(tabs[2].canvasTab!.id);
    expect(workspaceUtilityTab('customize', null).meta).toEqual({ projectId: 'personal' });
  } finally { vi.unstubAllGlobals(); }
});
