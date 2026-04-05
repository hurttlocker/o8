import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import { buildErrorPayload, sanitizeErrorMessage } from '@/lib/api/error-format';
import { listRepos } from '@/lib/repos/registry';

export const dynamic = 'force-dynamic';

const EDITORS: Record<string, { command: string }> = {
  'finder':       { command: 'open "{path}"' },
  'terminal':     { command: 'open -a Terminal "{path}"' },
  'vscode':       { command: 'code "{path}"' },
  'cursor':       { command: 'cursor "{path}"' },
  'zed':          { command: 'zed "{path}"' },
  'sublime':      { command: 'subl "{path}"' },
  'xcode':        { command: 'open -a Xcode "{path}"' },
  'jetbrains':    { command: 'idea "{path}"' },
  'windsurf':     { command: 'windsurf "{path}"' },
  'claude-code':  { command: 'claude "{path}"' },
};

// GET — return available editors (checks which CLIs exist)
export async function GET() {
  try {
    const available: { id: string; name: string; available: boolean }[] = [
      { id: 'finder', name: 'Finder', available: true },
      { id: 'terminal', name: 'Terminal', available: true },
    ];

    const editors = [
      { id: 'vscode', name: 'VS Code', bin: 'code' },
      { id: 'cursor', name: 'Cursor', bin: 'cursor' },
      { id: 'windsurf', name: 'Windsurf', bin: 'windsurf' },
      { id: 'zed', name: 'Zed', bin: 'zed' },
      { id: 'sublime', name: 'Sublime Text', bin: 'subl' },
      { id: 'xcode', name: 'Xcode', bin: 'xcodebuild' },
      { id: 'jetbrains', name: 'JetBrains', bin: 'idea' },
      { id: 'claude-code', name: 'Claude Code', bin: 'claude' },
    ];

    for (const editor of editors) {
      try {
        execSync(`which ${editor.bin} 2>/dev/null`, { encoding: 'utf-8' });
        available.push({ id: editor.id, name: editor.name, available: true });
      } catch {
        available.push({ id: editor.id, name: editor.name, available: false });
      }
    }

    return NextResponse.json({ editors: available });
  } catch (error) {
    console.error('[panel/open-in] Failed to list editors', error);
    return NextResponse.json(buildErrorPayload('Could not list editors.', error), { status: 500 });
  }
}

// POST — open repo in editor
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as { editor?: string; repo?: string } | null;
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { editor, repo } = body;
    const repoQuery = typeof repo === 'string' ? repo : '';
    if (!editor || !EDITORS[editor]) {
      return NextResponse.json({ error: 'Unknown editor' }, { status: 400 });
    }

    // Resolve repo to local path
    let localPath = '';
    if (repoQuery.trim() && existsSync(repoQuery)) {
      localPath = repoQuery;
    }

    if (!localPath) {
      try {
        const repos = await listRepos();
        const match = repos.find((entry) =>
          entry.localPath === repoQuery ||
          entry.remoteUrl?.includes(repoQuery) ||
          entry.localPath.includes(repoQuery),
        );
        localPath = match?.localPath ?? '';
      } catch { /* ignore */ }
    }

    // Fallback: check common paths
    if (!localPath) {
      const home = process.env.HOME || os.homedir();
      const repoName = repoQuery.split('/').pop() || repoQuery;
      const candidates = [
        `${process.cwd()}/../${repoName}`,
        `${home}/${repoName}`,
        `${home}/code/${repoName}`,
      ];
      for (const c of candidates) {
        try {
          execSync(`test -d "${c}"`, { encoding: 'utf-8' });
          localPath = c;
          break;
        } catch { /* not found */ }
      }
    }

    if (!localPath) {
      return NextResponse.json({ error: 'Could not resolve repo path' }, { status: 404 });
    }

    const cmd = EDITORS[editor].command.replace('{path}', localPath);
    execSync(cmd, { encoding: 'utf-8', timeout: 5000 });
    return NextResponse.json({ ok: true, editor, path: localPath });
  } catch (err) {
    console.error('[panel/open-in] Failed to open repo', err);
    return NextResponse.json({ error: `Failed to open: ${sanitizeErrorMessage(err, 'unknown')}` }, { status: 500 });
  }
}
