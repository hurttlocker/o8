import { NextResponse, type NextRequest } from 'next/server';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requirePanelAuth } from '@/lib/panel/auth';
import { findRepoByLocalPath } from '@/lib/repos/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Customize-page inventory: the data sources with no existing read API —
 * agent definitions (`.claude/agents/*.md`, project + user) and configured
 * hooks (`.claude/settings.json`, project + user), plus metadata for discovered
 * skills in known agent skill roots. Rules, Connections, and Commands come
 * from their existing sources (/api/cortex/directives,
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
  /** The settings.json that declares this hook — lets the UI open it. */
  file: string;
}

export interface CustomizeSkillEntry {
  name: string;
  description: string;
  scope: 'user' | 'project';
  source: 'o8' | 'shared' | 'codex' | 'claude-code' | 'gemini';
  file: string;
}

const MAX_INVENTORY_FILE_BYTES = 64 * 1024;

function parseAgentFrontmatter(raw: string): { name: string | null; description: string | null } {
  const normalized = raw.replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---/.exec(normalized);
  if (!match) return { name: null, description: null };
  const pick = (key: string): string | null => {
    const lines = match[1].split('\n');
    const field = new RegExp(`^${key}:\\s*(.*)$`);
    for (let index = 0; index < lines.length; index += 1) {
      const line = field.exec(lines[index]);
      if (!line) continue;
      const value = line[1].trim();
      if (!/^[|>][+-]?$/.test(value)) {
        return value ? value.replace(/^['"]|['"]$/g, '') : null;
      }
      const block: string[] = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        if (lines[next] && !/^\s/.test(lines[next])) break;
        block.push(lines[next].trim());
      }
      const separator = value.startsWith('>') ? ' ' : '\n';
      return block.join(separator).trim() || null;
    }
    return null;
  };
  return { name: pick('name'), description: pick('description') };
}

function readAgentsDir(dir: string, scope: 'user' | 'project', scopeRoot: string): CustomizeAgentEntry[] {
  if (!existsSync(dir)) return [];
  try {
    const root = realpathSync(dir);
    const boundary = realpathSync(scopeRoot);
    if (!root.startsWith(`${boundary}${path.sep}`)) return [];
    return readdirSync(root)
      .filter((file) => file.endsWith('.md'))
      .map((file) => {
        const candidate = path.join(root, file);
        let raw = '';
        let full = '';
        try {
          full = realpathSync(candidate);
          const metadata = statSync(full);
          if (!full.startsWith(`${root}${path.sep}`) || !metadata.isFile() || metadata.size > MAX_INVENTORY_FILE_BYTES) return null;
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

function readHooksFile(settingsPath: string, scope: 'user' | 'project', scopeRoot: string): CustomizeHookEntry[] {
  if (!existsSync(settingsPath)) return [];
  try {
    const boundary = realpathSync(scopeRoot);
    const file = realpathSync(settingsPath);
    const metadata = statSync(file);
    if (!file.startsWith(`${boundary}${path.sep}`) || !metadata.isFile() || metadata.size > MAX_INVENTORY_FILE_BYTES) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
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
            file,
          });
        }
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function readSkillsDir(
  dir: string,
  scope: CustomizeSkillEntry['scope'],
  source: CustomizeSkillEntry['source'],
  scopeRoot: string,
): CustomizeSkillEntry[] {
  if (!existsSync(dir)) return [];
  try {
    const root = realpathSync(dir);
    const boundary = realpathSync(scopeRoot);
    if (!root.startsWith(`${boundary}${path.sep}`)) return [];
    return readdirSync(root)
      .flatMap((entry) => {
        const candidate = path.join(root, entry, 'SKILL.md');
        try {
          const file = realpathSync(candidate);
          const metadata = statSync(file);
          if (!file.startsWith(`${root}${path.sep}`) || !metadata.isFile() || metadata.size > MAX_INVENTORY_FILE_BYTES) return [];
          const raw = readFileSync(file, 'utf8');
          const meta = parseAgentFrontmatter(raw);
          return [{
            name: (meta.name ?? entry).slice(0, 160),
            description: (meta.description ?? 'Local agent skill').replace(/\s+/g, ' ').slice(0, 240),
            scope,
            source,
            file,
          }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const repoParam = request.nextUrl.searchParams.get('repo')?.trim() || null;
  if (repoParam && (!path.isAbsolute(repoParam) || repoParam.split(path.sep).includes('..'))) {
    return NextResponse.json({ ok: false, error: { code: 'invalid_repo_path', message: 'Repository path is invalid.' } }, { status: 400 });
  }
  const registeredRepo = repoParam ? await findRepoByLocalPath(repoParam) : null;
  if (repoParam && !registeredRepo) {
    return NextResponse.json({ ok: false, error: { code: 'repo_not_registered', message: 'Repository is not registered.' } }, { status: 403 });
  }
  const repoPath = registeredRepo?.localPath ?? null;

  const home = os.homedir();
  const agents: CustomizeAgentEntry[] = [
    ...readAgentsDir(path.join(home, '.claude', 'agents'), 'user', home),
    ...(repoPath ? readAgentsDir(path.join(repoPath, '.claude', 'agents'), 'project', repoPath) : []),
  ];
  const hooks: CustomizeHookEntry[] = [
    ...readHooksFile(path.join(home, '.claude', 'settings.json'), 'user', home),
    ...(repoPath ? readHooksFile(path.join(repoPath, '.claude', 'settings.json'), 'project', repoPath) : []),
  ];

  const skills: CustomizeSkillEntry[] = [
    ...readSkillsDir(path.join(home, '.o8', 'skills'), 'user', 'o8', home),
    ...readSkillsDir(path.join(home, '.agents', 'skills'), 'user', 'shared', home),
    ...readSkillsDir(path.join(home, '.codex', 'skills'), 'user', 'codex', home),
    ...readSkillsDir(path.join(home, '.claude', 'skills'), 'user', 'claude-code', home),
    ...readSkillsDir(path.join(home, '.gemini', 'skills'), 'user', 'gemini', home),
    ...(repoPath ? [
      ...readSkillsDir(path.join(repoPath, '.agents', 'skills'), 'project', 'shared', repoPath),
      ...readSkillsDir(path.join(repoPath, '.claude', 'skills'), 'project', 'claude-code', repoPath),
    ] : []),
  ].sort((left, right) => (
    (left.scope === right.scope ? 0 : left.scope === 'project' ? -1 : 1)
    || left.name.localeCompare(right.name)
    || left.source.localeCompare(right.source)
  ));

  const seen = new Set<string>();
  const uniqueSkills = skills.filter((skill) => {
    if (seen.has(skill.file)) return false;
    seen.add(skill.file);
    return true;
  });
  return NextResponse.json({ ok: true, agents, hooks, skills: uniqueSkills });
}
