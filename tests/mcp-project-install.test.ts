import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'o8-mcp-project-install-'));
const home = join(root, 'home');
const projectPath = join(root, 'project');
const bundlePath = join(root, 'operator-mcp-server.mjs');
mkdirSync(home, { recursive: true });
mkdirSync(projectPath, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectPath });
execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/test/project.git'], { cwd: projectPath });
writeFileSync(bundlePath, '');
process.env.HOME = home;
process.env.O8_BUNDLED_MCP_PATH = bundlePath;
process.env.O8_BUNDLED_MCP_DIR = root;
process.env.O8_NODE_BIN = process.execPath;
process.env.O8_API_PORT = '47120';
process.env.O8_WS_PORT = '47125';

const route = await import('@/app/api/setup/claude-desktop/route');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('Claude Code MCP install', () => {
  it('refreshes the project .mcp.json o8 entry through the real install route', async () => {
    const projectConfigPath = join(projectPath, '.mcp.json');
    writeFileSync(projectConfigPath, JSON.stringify({
      mcpServers: {
        other: { command: 'other-mcp' },
        o8: { url: 'http://127.0.0.1:18795/mcp' },
      },
    }, null, 2));

    const response = await route.POST(new Request('http://localhost/api/setup/claude-desktop', {
      method: 'POST',
      body: JSON.stringify({ target: 'claude-code', projectPath }),
    }));
    const payload = await response.json() as { projectConfigPath?: string };
    const written = JSON.parse(readFileSync(projectConfigPath, 'utf8')) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(payload.projectConfigPath).toBe(projectConfigPath);
    expect(written.mcpServers.other).toEqual({ command: 'other-mcp' });
    expect(written.mcpServers.o8).toMatchObject({ command: process.execPath, args: [bundlePath] });
    expect(written.mcpServers.o8).not.toHaveProperty('url');
  });
});
