import { NextRequest, NextResponse } from 'next/server';
import { execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import os from 'os';
import { buildErrorPayload, sanitizeErrorMessage } from '@/lib/api/error-format';
import { listRepos } from '@/lib/repos/registry';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';

export const dynamic = 'force-dynamic';

// argv form (bin + fixed args) — the resolved path is appended as a final
// positional arg and run via execFileSync.
//
// That used to mean "never shell-interpreted", and on POSIX it still does. On
// Windows it does NOT: entries below go through cmd.exe, which re-parses the
// command line, and Node quotes only for spaces and quotes. A path containing
// `&`, `|`, `^`, `<` or `>` — all legal in Windows filenames — would split the
// line. Such paths are rejected outright rather than quoted, since no editor
// integration is worth an argument-injection surface.
const IS_WINDOWS = process.platform === 'win32';

const EDITORS: Record<string, { bin: string; args: string[] }> = {
  // `open` is macOS-only. explorer.exe is spawned DIRECTLY (not through
  // `cmd /c start`) so no shell re-parses the path — its documented quirk is
  // that it exits 1 even on success, which the caller tolerates.
  'finder':       IS_WINDOWS ? { bin: 'explorer.exe', args: [] } : { bin: 'open', args: [] },
  'terminal':     IS_WINDOWS ? { bin: 'cmd.exe', args: ['/d', '/k', 'cd', '/d'] } : { bin: 'open', args: ['-a', 'Terminal'] },
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

    // Editor CLIs on Windows are .cmd shims (VS Code ships `code.cmd`), so most
    // of these reach cmd.exe — which re-parses its command line. Reject the
    // metacharacters that would split it rather than trying to quote around
    // them; all are legal in Windows filenames, so this is a real path, not a
    // theoretical one.
    if (IS_WINDOWS && /[&|^<>%]/.test(localPath)) {
      return NextResponse.json(
        { error: 'Repo path contains a character that cannot be passed safely to the Windows shell.' },
        { status: 400 },
      );
    }

    const { bin, args } = EDITORS[editor];
    const open = cliInvocation(bin, [...args, localPath]);
    try {
      execFileSync(open.command, open.args, { windowsHide: true, encoding: 'utf-8', timeout: 5000 });
    } catch (spawnError) {
      // explorer.exe returns 1 even when it succeeded; every other entry treats
      // a non-zero exit as a real failure.
      if (!(IS_WINDOWS && bin === 'explorer.exe')) throw spawnError;
    }
    return NextResponse.json({ ok: true, editor, path: localPath });
  } catch (err) {
    console.error('[panel/open-in] Failed to open repo', err);
    return NextResponse.json({ error: `Failed to open: ${sanitizeErrorMessage(err, 'unknown')}` }, { status: 500 });
  }
}
