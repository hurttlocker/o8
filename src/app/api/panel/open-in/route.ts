import { NextRequest, NextResponse } from 'next/server';
import { execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import os from 'os';
import { buildErrorPayload, sanitizeErrorMessage } from '@/lib/api/error-format';
import { listRepos } from '@/lib/repos/registry';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';

export const dynamic = 'force-dynamic';

// argv form (bin + fixed args) — the resolved path is appended as a final
// positional arg and run via execFileSync (no shell), so a path can never be
// shell-interpreted.
const IS_WINDOWS = process.platform === 'win32';

const EDITORS: Record<string, { bin: string; args: string[] }> = {
  // `open` is macOS-only; Windows has explorer for the file manager and cmd
  // for a shell. Without this the first two rows of the picker 500 on click.
  // explorer.exe exits 1 even when it succeeds, so it cannot be run through the
  // normal execFileSync path — `start` swallows the code.
  'finder':       IS_WINDOWS ? { bin: 'cmd', args: ['/d', '/c', 'start', '', ''] } : { bin: 'open', args: [] },
  'terminal':     IS_WINDOWS ? { bin: 'cmd', args: ['/c', 'start', 'cmd', '/k', 'cd', '/d'] } : { bin: 'open', args: ['-a', 'Terminal'] },
  'vscode':       { bin: 'code', args: [] },
  'cursor':       { bin: 'cursor', args: [] },
  'zed':          { bin: 'zed', args: [] },
  'sublime':      { bin: 'subl', args: [] },
  // macOS-only; a direct POST from a stale client would otherwise 500.
  ...(IS_WINDOWS ? {} : { 'xcode': { bin: 'open', args: ['-a', 'Xcode'] } }),
  'jetbrains':    { bin: 'idea', args: [] },
  'windsurf':     { bin: 'windsurf', args: [] },
  'claude-code':  { bin: 'claude', args: [] },
};

// GET — return available editors (checks which CLIs exist)
export async function GET() {
  try {
    const available: { id: string; name: string; available: boolean }[] = [
      { id: 'finder', name: IS_WINDOWS ? 'File Explorer' : 'Finder', available: true },
      { id: 'terminal', name: IS_WINDOWS ? 'Command Prompt' : 'Terminal', available: true },
    ];

    const editors = [
      { id: 'vscode', name: 'VS Code', bin: 'code' },
      { id: 'cursor', name: 'Cursor', bin: 'cursor' },
      { id: 'windsurf', name: 'Windsurf', bin: 'windsurf' },
      { id: 'zed', name: 'Zed', bin: 'zed' },
      { id: 'sublime', name: 'Sublime Text', bin: 'subl' },
      ...(IS_WINDOWS ? [] : [{ id: 'xcode', name: 'Xcode', bin: 'xcodebuild' }]),
      { id: 'jetbrains', name: 'JetBrains', bin: 'idea' },
      { id: 'claude-code', name: 'Claude Code', bin: 'claude' },
    ];

    for (const editor of editors) {
      try {
        execFileSync(process.platform === 'win32' ? 'where' : 'which', [editor.bin], { windowsHide: true, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
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
          if (existsSync(c) && statSync(c).isDirectory()) {
            localPath = c;
            break;
          }
        } catch { /* not found */ }
      }
    }

    if (!localPath) {
      return NextResponse.json({ error: 'Could not resolve repo path' }, { status: 404 });
    }

    const { bin, args } = EDITORS[editor];
    // Editor CLIs on Windows are .cmd shims (VS Code ships `code.cmd`), so
    // "open in editor" would fail without the interpreter.
    const open = cliInvocation(bin, [...args, localPath]);
    execFileSync(open.command, open.args, { windowsHide: true, encoding: 'utf-8', timeout: 5000 });
    return NextResponse.json({ ok: true, editor, path: localPath });
  } catch (err) {
    console.error('[panel/open-in] Failed to open repo', err);
    return NextResponse.json({ error: `Failed to open: ${sanitizeErrorMessage(err, 'unknown')}` }, { status: 500 });
  }
}
