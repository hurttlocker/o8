import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../output.js';

type McpTarget = 'print' | 'claude-code' | 'cursor';

function resolveProjectPath(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      windowsHide: true,
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 5_000,
    }).trim() || process.cwd();
  } catch {
    return process.cwd();
  }
}

function parseMcpArgs(sub: string | undefined, rest: string[]): { target: McpTarget } {
  if (sub !== 'install') {
    throw new CliError(
      'unknown_mcp_subcommand',
      `Unknown mcp subcommand: ${sub ?? '(none)'}`,
      EXIT.INVALID_ARGS,
      'Run `o8 mcp install --print` to emit a generic MCP config.',
    );
  }

  let target: McpTarget = 'print';
  for (const token of rest) {
    if (token === '--print') target = 'print';
    else if (token === '--claude-code') target = 'claude-code';
    else if (token === '--cursor') target = 'cursor';
    else {
      throw new CliError('invalid_args', `Unknown mcp install flag: ${token}`, EXIT.INVALID_ARGS);
    }
  }
  return { target };
}

export async function runMcp(mode: OutputMode, sub: string | undefined, rest: string[]): Promise<number> {
  const args = parseMcpArgs(sub, rest);
  const cfg = resolveConfig();

  if (args.target === 'claude-code') {
    const res = await apiFetch<Record<string, unknown>>(cfg, '/api/setup/claude-desktop', {
      method: 'POST',
      body: { target: 'claude-code', projectPath: resolveProjectPath() },
    });
    const payload = {
      schema: 'o8/cli/mcp-install/v1',
      target: args.target,
      result: res.data,
    };
    if (mode.human) {
      printHumanHeading('mcp install');
      printHumanKv([
        ['target', 'Claude Code'],
        ['status', res.status < 400 ? 'installed' : 'failed'],
      ]);
    } else {
      printJson(payload);
    }
    return res.status < 400 ? 0 : 1;
  }

  const res = await apiFetch<{
    setupReady?: boolean;
    setupBlockedDetail?: string | null;
    fullConfig: Record<string, unknown>;
  }>(cfg, '/api/setup/mcp-config');
  const data = res.data;
  if (!data) {
    throw new CliError('mcp_config_empty', 'The o8 server returned an empty MCP config response.', EXIT.CONFLICT);
  }
  if (data.setupReady === false) {
    throw new CliError(
      'mcp_setup_not_ready',
      data.setupBlockedDetail ?? 'MCP setup is not ready.',
      EXIT.CONFLICT,
      'Finish first launch, then retry `o8 mcp install --print`.',
    );
  }

  const cursorPath = join(homedir(), '.cursor', 'mcp.json');
  const payload = {
    schema: 'o8/cli/mcp-install/v1',
    target: args.target,
    config: data.fullConfig,
    destination: args.target === 'cursor' ? cursorPath : null,
    note: args.target === 'cursor'
    ? `Write this JSON to ${cursorPath}, then restart Cursor.`
    : 'Use this JSON with any MCP client that accepts a Claude-style mcpServers object.',
  };
  if (mode.human) {
    printHumanHeading(args.target === 'cursor' ? 'cursor mcp config' : 'mcp config');
    process.stdout.write(`${JSON.stringify(data.fullConfig, null, 2)}\n`);
    if (payload.note) process.stdout.write(`\n${payload.note}\n`);
  } else {
    printJson(payload);
  }
  return 0;
}
