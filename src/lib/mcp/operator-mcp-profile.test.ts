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
    const fullNames = operatorToolsForProfile('full').map((tool) => tool.name);
    expect(fullNames).toContain('o8_update_apply');
    expect(fullNames).toContain('o8_problem_list');
    expect(fullNames).toContain('o8_problem_get');
    expect(operatorToolsForProfile('misspelled-dogfood')).toEqual([]);
  });

  it('publishes the complete strict harness surface only in the full profile', () => {
    const harnessNames = [
      'o8_feature_list',
      'o8_feature_next',
      'o8_feature_add',
      'o8_feature_verify',
      'o8_ground_task',
      'o8_session_boot',
      'o8_negotiate_contract',
      'o8_sprint',
      'o8_verify',
      'o8_harness_lift_status',
      'o8_harness_measure',
      'o8_harness_transition',
      'o8_capabilities',
      'o8_evaluate_diff',
      'o8_harness_bundle',
    ];
    const fullTools = operatorToolsForProfile('full');
    const fullNames = fullTools.map((tool) => tool.name);
    const dogfoodNames = operatorToolsForProfile('dogfood').map((tool) => tool.name);

    for (const name of harnessNames) {
      expect(fullNames).toContain(name);
      expect(dogfoodNames).not.toContain(name);
      expect(fullTools.find((tool) => tool.name === name)?.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        properties: expect.any(Object),
        required: expect.any(Array),
      });
    }
  });

  it('publishes strict resource lease tools only in the full profile', () => {
    const leaseNames = [
      'o8_lease_acquire',
      'o8_lease_release',
      'o8_lease_status',
      'o8_lease_list',
    ];
    const fullTools = operatorToolsForProfile('full');
    const dogfoodNames = operatorToolsForProfile('dogfood').map((tool) => tool.name);
    for (const name of leaseNames) {
      expect(fullTools.find((tool) => tool.name === name)?.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        properties: expect.any(Object),
        required: expect.any(Array),
      });
      expect(dogfoodNames).not.toContain(name);
    }
  });
});
