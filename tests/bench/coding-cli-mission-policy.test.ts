import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliError } from '../../cli/src/api';
import { runMission } from '../../cli/src/commands/mission';
import {
  GOVERNED_EXISTING_BRANCH_POLICY,
  governedMissionCreateArgs,
} from '../../scripts/bench/coding-governed-mission';

const mode = { human: false, verbose: false };

function textContent(result: {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
}): string {
  return result.content.find((entry) => entry.type === 'text')?.text ?? '';
}

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('mission existing-branch policy', () => {
  it('rejects an invalid CLI value with the same message as the MCP path', async () => {
    const { handleCreateMission } = await import('../../src/lib/mcp/operator-handlers/mission');
    const mcpResult = await handleCreateMission({
      repoPath: '/tmp/o8-policy-test',
      issues_inline: [{ title: 'policy parity' }],
      existingBranchPolicy: 'replace',
      dispatch: false,
    });
    const mcpMessage = textContent(mcpResult).replace(/^Failed to create mission: /, '');

    let cliError: unknown;
    try {
      await runMission(mode, 'create', [
        '--title', 'policy parity',
        '--existingBranchPolicy', 'replace',
      ]);
    } catch (error) {
      cliError = error;
    }

    expect(cliError).toBeInstanceOf(CliError);
    expect((cliError as CliError).message).toBe(mcpMessage);
  });

  it('passes reset to the route, omits the field by default, and keeps JSON output stable', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({
        ok: true,
        result: {
          missionId: `mission-${bodies.length}`,
          packets: [{ id: `pkt-${bodies.length}`, title: 'policy parity', wave: 1 }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const write = vi.mocked(process.stdout.write);

    await runMission(mode, 'create', [
      '--title', 'policy parity',
      '--existingBranchPolicy', 'reset',
    ]);
    await runMission(mode, 'create', ['--title', 'route default parity']);

    expect(bodies[0]?.existingBranchPolicy).toBe('reset');
    expect(bodies[1]).not.toHaveProperty('existingBranchPolicy');
    expect(write.mock.calls.map(([value]) => String(value)).join('')).toContain(
      '"schema": "o8/cli/mission.create/v1"',
    );
  });

  it('builds governed mission creation with a recorded fresh-start policy', () => {
    const args = governedMissionCreateArgs({
      title: 'governed policy',
      body: 'body',
      repoRoot: '/repo',
      issue: 1676,
    });
    const policyFlag = args.indexOf('--existingBranchPolicy');

    expect(GOVERNED_EXISTING_BRANCH_POLICY).toBe('reset');
    expect(args.slice(policyFlag, policyFlag + 2)).toEqual([
      '--existingBranchPolicy',
      GOVERNED_EXISTING_BRANCH_POLICY,
    ]);
  });
});
