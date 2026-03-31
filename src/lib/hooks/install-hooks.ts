import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface ClaudeSettingsHook {
  type: 'command';
  command: string;
  timeout?: number;
}

interface ClaudeSettingsHookGroup {
  matcher?: string;
  hooks: ClaudeSettingsHook[];
}

interface ClaudeSettingsFile {
  hooks?: Record<string, ClaudeSettingsHookGroup[]>;
  [key: string]: unknown;
}

function quoteShellArg(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readSettings(settingsPath: string): ClaudeSettingsFile {
  if (!existsSync(settingsPath)) {
    return {};
  }
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    return JSON.parse(raw) as ClaudeSettingsFile;
  } catch {
    return {};
  }
}

export function installClaudeCodePreToolHook(projectRoot: string) {
  const claudeDir = join(projectRoot, '.claude');
  const settingsPath = join(claudeDir, 'settings.json');
  const distScriptPath = join(projectRoot, 'dist', 'hooks', 'claude-code-pretool-hook.js');
  const sourceScriptPath = join(projectRoot, 'src', 'lib', 'hooks', 'claude-code-pretool-hook.ts');
  const scriptPath = existsSync(distScriptPath) ? distScriptPath : sourceScriptPath;
  const command = existsSync(distScriptPath)
    ? `${process.execPath} ${quoteShellArg(scriptPath)}`
    : `npx tsx ${quoteShellArg(scriptPath)}`;

  mkdirSync(claudeDir, { recursive: true });

  const settings = readSettings(settingsPath);
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const alreadyInstalled = preToolUse.some((group) => (
    Array.isArray(group.hooks)
    && group.hooks.some((hook) => hook.type === 'command' && hook.command.includes('claude-code-pretool-hook'))
  ));

  if (!alreadyInstalled) {
    preToolUse.push({
      matcher: '*',
      hooks: [{
        type: 'command',
        command,
        timeout: 10,
      }],
    });
  }

  settings.hooks = {
    ...hooks,
    PreToolUse: preToolUse,
  };

  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return {
    settingsPath,
    command,
  };
}
