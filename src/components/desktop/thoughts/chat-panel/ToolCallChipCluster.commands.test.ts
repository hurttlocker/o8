// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileTranscriptToolCall } from '@/lib/mobile/types';
import { ToolCallChipCluster } from './ToolCallChipCluster';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const show = (tool: MobileTranscriptToolCall) => act(() => root.render(createElement(ToolCallChipCluster, { toolCalls: [tool] })));

describe('built-in command activity labels', () => {
  it.each(['o8_run', 'o8_command_help', 'functions.o8_run', 'mcp__o8__o8_command_help'])(
    'names the command when the operator expands %s', (name) => {
      show({ id: 'call-1', name, args: { name: 'cortex_list_prs', arguments: '{"state":"open"}' }, status: 'done' });
      act(() => container.querySelector('button')!.click());
      const row = container.querySelector('button[aria-label$="show detail"]')!;
      expect(row.textContent).toContain('cortex_list_prs');
      expect(row.textContent).not.toContain('tool activity');
      if (name.endsWith('o8_command_help')) expect(row.textContent).toContain('Help');
      act(() => (row as HTMLButtonElement).click());
      expect(container.textContent).toContain('state');
    },
  );

  it('updates a running row when streamed command arguments arrive', () => {
    const tool = { id: 'call-1', name: 'o8_run', status: 'running' as const };
    show(tool);
    show({ ...tool, args: { name: 'cortex_list_issues' } });
    expect(container.textContent).toContain('cortex_list_issues');
    expect(container.textContent).not.toContain('tool activity');
  });

  it('keeps malformed or missing command names inspectable without inventing one', () => {
    show({ id: 'call-1', name: 'o8_run', args: { name: 42 }, status: 'done' });
    act(() => container.querySelector('button')!.click());
    expect(container.querySelector('button[aria-label$="show detail"]')).not.toBeNull();
    expect(container.textContent).not.toContain('undefined');
  });
});
