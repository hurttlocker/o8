import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';

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
  'opencode':     { command: 'opencode "{path}"' },
};

// GET — return available editors (checks which CLIs exist)
export async function GET() {
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
    { id: 'opencode', name: 'OpenCode', bin: 'opencode' },
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
}

// POST — open repo in editor
export async function POST(req: NextRequest) {
  const { editor, repo } = await req.json();

  if (!editor || !EDITORS[editor]) {
    return NextResponse.json({ error: 'Unknown editor' }, { status: 400 });
  }

  // Resolve repo to local path
  let localPath = '';
  try {
    const reposJson = execSync('cat ~/.openclaw/repos.json 2>/dev/null || echo "[]"', { encoding: 'utf-8' });
    const repos = JSON.parse(reposJson);
    const match = repos.find((r: { remoteUrl?: string; localPath?: string }) => 
      r.remoteUrl?.includes(repo) || r.localPath?.includes(repo)
    );
    localPath = match?.localPath ?? '';
  } catch { /* ignore */ }

  // Fallback: check common paths
  if (!localPath) {
    const home = process.env.HOME || require('os').homedir();
    const repoName = repo.split('/').pop() || repo;
    const candidates = [
      `process.cwd() + '/../'${repoName}`,
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
  try {
    execSync(cmd, { encoding: 'utf-8', timeout: 5000 });
    return NextResponse.json({ ok: true, editor, path: localPath });
  } catch (err) {
    return NextResponse.json({ error: `Failed to open: ${err instanceof Error ? err.message : 'unknown'}` }, { status: 500 });
  }
}
