import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolCallChipCluster } from './ToolCallChipCluster';

describe('ToolCallChipCluster stopped calls (#3659)', () => {
  it('shows a call the operator stopped as stopped, not running or failed', () => {
    const html = renderToStaticMarkup(createElement(ToolCallChipCluster, {
      toolCalls: [{ id: 'call-1', name: 'run_command', args: { command: 'sleep 90' }, status: 'stopped' }],
    }));
    expect(html).toContain('stopped');
    expect(html).not.toMatch(/failed|running/);
  });
});
