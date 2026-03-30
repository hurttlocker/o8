import { NextResponse } from 'next/server';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const getServerPath = () => join(process.cwd(), 'src/lib/mcp/operator-mcp-server.ts');
const getSettingsPath = () => join(homedir(), '.claude', 'settings.json');

async function readSettings(settingsPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(settingsPath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function GET() {
  const serverPath = getServerPath();
  const configPath = getSettingsPath();

  try {
    const settings = await readSettings(configPath);
    const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
    const installed = !!mcpServers?.o8;
    return NextResponse.json({ installed, configPath, serverPath });
  } catch {
    return NextResponse.json({ installed: false, configPath, serverPath });
  }
}

export async function POST() {
  const serverPath = getServerPath();
  const configPath = getSettingsPath();

  try {
    await mkdir(join(homedir(), '.claude'), { recursive: true });
    const settings = await readSettings(configPath);

    if (!settings.mcpServers) settings.mcpServers = {};
    const mcpServers = settings.mcpServers as Record<string, unknown>;
    mcpServers['o8'] = {
      command: 'npx',
      args: ['tsx', serverPath],
      env: {
        O8_API_BASE: `http://localhost:${process.env.PORT || 3001}`,
      },
    };

    await writeFile(configPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');

    return NextResponse.json({
      ok: true,
      configPath,
      serverPath,
      note: 'Restart Claude Code to activate o8 tools.',
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
