import { NextResponse, type NextRequest } from 'next/server';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Customize-page inventory: the two data sources with no existing read API —
 * agent definitions (`.claude/agents/*.md`, project + user) and configured
 * hooks (`.claude/settings.json`, project + user). Rules, Connections, and
 * Commands come from their existing sources (/api/cortex/directives,
 * /api/setup/mcp-servers, the static slash-command registry).
 *
 * Read-only by design: this surface INVENTORIES customizations; editing
 * happens where each artifact already lives.
 */

export interface CustomizeAgentEntry {
  name: string;
  description: string | null;
  scope: 'user' | 'project';
  file: string;
}

export interface CustomizeHookEntry {
  event: string;
  command: string;
  matcher: string | null;
  scope: 'user' | 'project';
}

function parseAgentFrontmatter(raw: string): { name: string | null; description: string | null } {
  const match = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!match) return { name: null, description: null };
  const pick = (key: string): string | null => {
    const line = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(match[1]);
    return line ? line[1].trim().replace(/^['"]|['"]$/g, '') : null;
  };
  return { name: pick('name'), description: pick('description') };
}

function readAgentsDir(dir: string, scope: 'user' | 'project'): CustomizeAgentEntry[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => {
        const full = path.join(dir, file);
        let raw = '';
        try {
          raw = readFileSync(full, 'utf8');
        } catch {
          return null;
        }
        const meta = parseAgentFrontmatter(raw);
        return {
          name: meta.name ?? file.replace(/\.md$/, ''),
          // Keep descriptions single-line and bounded for list rows.
          description: meta.description ? meta.description.replace(/\s+/g, ' ').slice(0, 240) : null,
          scope,
          file: full,
        };
      })
      .filter((entry): entry is CustomizeAgentEntry => entry !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function readHooksFile(settingsPath: string, scope: 'user' | 'project'): CustomizeHookEntry[] {
  if (!existsSync(settingsPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string; type?: string }> }>>;
    };
    if (!parsed?.hooks || typeof parsed.hooks !== 'object') return [];
    const entries: CustomizeHookEntry[] = [];
    for (const [event, groups] of Object.entries(parsed.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        for (const hook of group?.hooks ?? []) {
          if (typeof hook?.command !== 'string' || !hook.command.trim()) continue;
          entries.push({
            event,
            command: hook.command.trim(),
            matcher: typeof group.matcher === 'string' && group.matcher.trim() ? group.matcher.trim() : null,
            scope,
          });
        }
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  const repoParam = request.nextUrl.searchParams.get('repo')?.trim() || null;
  // Fail closed on path games: the repo param must be an absolute path with no
  // traversal segments — this route reads files relative to it.
  const repoPath = repoParam && path.isAbsolute(repoParam) && !repoParam.includes('..')
    ? repoParam
    : null;

  const home = os.homedir();
  const agents: CustomizeAgentEntry[] = [
    ...readAgentsDir(path.join(home, '.claude', 'agents'), 'user'),
    ...(repoPath ? readAgentsDir(path.join(repoPath, '.claude', 'agents'), 'project') : []),
  ];
  const hooks: CustomizeHookEntry[] = [
    ...readHooksFile(path.join(home, '.claude', 'settings.json'), 'user'),
    ...(repoPath ? readHooksFile(path.join(repoPath, '.claude', 'settings.json'), 'project') : []),
  ];

  return NextResponse.json({ ok: true, agents, hooks });
}
