import { afterEach, describe, expect, it } from 'vitest';
import { handleOperatorMcpMessage, operatorToolsForProfile } from './operator-mcp-host';

const originalProfile = process.env.O8_OPERATOR_MCP_PROFILE;

afterEach(() => {
  if (originalProfile === undefined) delete process.env.O8_OPERATOR_MCP_PROFILE;
  else process.env.O8_OPERATOR_MCP_PROFILE = originalProfile;
});

describe('operator MCP process profiles', () => {
  it('exposes only visible app-driving tools to the dogfood loop', () => {
    const names = operatorToolsForProfile('dogfood').map((tool) => tool.name);

    expect(names).toContain('o8_view_wait_for');
    expect(names).toContain('o8_view_type');
    expect(names).toContain('o8_view_click');
    expect(names).toContain('o8_view_console_errors');
    expect(names.every((name) => name.startsWith('o8_view_'))).toBe(true);
    expect(names).not.toContain('o8_task_create');
    expect(names).not.toContain('create_mission');
    expect(names).not.toContain('dispatch_mission');
    expect(names).not.toContain('approve_and_merge');
  });

  it('blocks a hidden tool even when a client calls it without discovery', async () => {
    process.env.O8_OPERATOR_MCP_PROFILE = 'dogfood';
    const response = await handleOperatorMcpMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'o8_task_create', arguments: { title: 'escape profile' } },
    });

    expect(response).toMatchObject({
      id: 7,
      result: {
        isError: true,
        content: [{ type: 'text' }],
      },
    });
    expect(JSON.stringify(response)).toContain('Tool unavailable in operator MCP profile dogfood');
  });

  it('fails closed for an unknown explicit profile while preserving the normal default', () => {
    expect(operatorToolsForProfile('full').map((tool) => tool.name)).toContain('o8_update_apply');
    expect(operatorToolsForProfile('misspelled-dogfood')).toEqual([]);
  });
});
