import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: (handler: unknown) => handler,
}));

const dataDir = mkdtempSync(join(tmpdir(), 'o8-mcp-http-'));
const token = 'vitest-mcp-route-token-0123456789';
writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, 'utf-8');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.PORT = '47120';

const { panelGateMiddleware } = await import('@/middleware');
const { POST } = await import('@/app/api/mcp/route');

function mcpRequest(body: Record<string, unknown>): Request {
  return new Request('http://127.0.0.1:47120/api/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('/api/mcp — real operator host reachability', () => {
  it('round-trips tools/list and a real o8_status call through the route', async () => {
    const gateResponse = panelGateMiddleware(new NextRequest(mcpRequest({})));
    expect(gateResponse.status).toBe(200);

    const listResponse = await POST(mcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json() as {
      result: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
    };
    const toolNames = listBody.result.tools.map((tool) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining([
      'o8_status',
      'o8_list_repos',
      'o8_remove_repo',
      'o8_list_projects',
      'o8_set_active_project',
      'o8_set_project_repos',
      'o8_delete_project',
      'approve_and_merge',
      'o8_view_surface_state',
      'o8_spec_reply',
    ]));
    for (const tool of listBody.result.tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.inputSchema.properties, tool.name).toBeTypeOf('object');
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/operator/status')) {
        return Response.json({ agents: [], approvals: { items: [], count: 0 }, recentActivity: [] });
      }
      if (url.endsWith('/api/panel/repos')) return Response.json({ repos: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const callResponse = await POST(mcpRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'o8_status', arguments: {} },
    }));
    expect(callResponse.status).toBe(200);
    const callBody = await callResponse.json() as {
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    };
    expect(callBody.result.isError).not.toBe(true);
    expect(JSON.parse(callBody.result.content[0].text)).toMatchObject({
      data: { agents: [], approvalCount: 0 },
    });
  });

  it('deletes a project through the public MCP tool and returns disk-preservation receipts', async () => {
    let repos = [{
      id: 'repo-site',
      name: 'site',
      localPath: '/tmp/site',
      remoteUrl: null,
      defaultBranch: 'main',
      exists: true,
    }];
    const projects = [
      { id: 'workspace', name: 'Workspace', repoPaths: [] },
      { id: 'project-site', name: 'Site', repoPaths: ['/tmp/site'] },
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/panel/projects') && (!init?.method || init.method === 'GET')) {
        return Response.json({ activeProjectId: 'project-site', projects });
      }
      if (url.endsWith('/api/panel/repos') && (!init?.method || init.method === 'GET')) {
        return Response.json({ repos });
      }
      if (url.endsWith('/api/panel/projects/project-site') && init?.method === 'DELETE') {
        repos = [];
        return Response.json({ activeProjectId: 'workspace', projects: [projects[0]] });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    const callResponse = await POST(mcpRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'o8_delete_project', arguments: { projectId: 'project-site' } },
    }));
    expect(callResponse.status).toBe(200);
    const callBody = await callResponse.json() as {
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    };
    expect(callBody.result.isError).not.toBe(true);
    expect(JSON.parse(callBody.result.content[0].text)).toMatchObject({
      removedProject: { id: 'project-site', name: 'Site' },
      removedExclusiveRepoCount: 1,
      removedExclusiveRepos: [{ id: 'repo-site', repoPath: '/tmp/site' }],
      localFoldersPreserved: true,
      activeProjectId: 'workspace',
    });
  });
});
