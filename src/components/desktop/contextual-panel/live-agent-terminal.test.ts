import { describe, expect, it } from 'vitest';
import { attachLiveAgentTerminalTab, type LiveAgentTerminalTab } from './live-agent-terminal';

describe('attachLiveAgentTerminalTab', () => {
  it('creates a read-only live run tab and selects it', () => {
    const result = attachLiveAgentTerminalTab<LiveAgentTerminalTab>([], {
      session: 'cortex-run-abcdef123',
      label: 'dev side-stack :3998',
      tabCount: 2,
      now: 1_000,
    });

    expect(result.activeTabId).toBe('bottom-agent-3');
    expect(result.nextTabCount).toBe(3);
    expect(result.tabs).toEqual([{
      id: 'bottom-agent-3',
      label: 'dev side-stack :3998',
      kind: 'terminal',
      tmuxSession: 'cortex-run-abcdef123',
      readOnly: true,
      createdAt: 1_000,
      lastActivity: 1_000,
    }]);
  });

  it('focuses an existing run tab and refreshes its human label', () => {
    const result = attachLiveAgentTerminalTab<LiveAgentTerminalTab>([{
      id: 'bottom-agent-1',
      label: 'sh -c PORT=3998 O8_API_PORT=3998 npm run desktop:dev:side',
      kind: 'terminal',
      tmuxSession: 'cortex-run-abcdef123',
      readOnly: true,
      createdAt: 1_000,
      lastActivity: 1_000,
    }], {
      session: 'cortex-run-abcdef123',
      label: 'dev side-stack :3998',
      tabCount: 1,
      now: 2_000,
    });

    expect(result.activeTabId).toBe('bottom-agent-1');
    expect(result.nextTabCount).toBe(1);
    expect(result.tabs[0]?.label).toBe('dev side-stack :3998');
    expect(result.tabs[0]?.lastActivity).toBe(2_000);
  });
});
