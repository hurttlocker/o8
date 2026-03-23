export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

const DEFAULT_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();

interface SearchResult {
  file: string;
  line: number;
  text: string;
  matchType: 'code' | 'filename';
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.trim();
  const workspaceParam = searchParams.get('workspace');

  if (!query || query.length < 2) {
    return NextResponse.json({ results: [], query: query ?? '' });
  }

  const home = process.env.HOME || require('os').homedir();
  let root = DEFAULT_ROOT;
  if (workspaceParam) {
    root = workspaceParam.startsWith('~') ? workspaceParam.replace('~', home) : workspaceParam;
  }

  const results: SearchResult[] = [];

  // 1. Filename matches (fast)
  try {
    const findOutput = execSync(
      `find . -maxdepth 5 -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/target/*' -not -path '*/dist/*' | grep -i "${query.replace(/"/g, '')}" | head -10`,
      { cwd: root, encoding: 'utf-8', timeout: 3000 },
    );
    for (const line of findOutput.trim().split('\n').filter(Boolean)) {
      const clean = line.startsWith('./') ? line.slice(2) : line;
      results.push({ file: clean, line: 0, text: '', matchType: 'filename' });
    }
  } catch { /* no filename matches */ }

  // 2. Content matches via ripgrep (fast, respects .gitignore)
  try {
    const rgOutput = execSync(
      `rg --json -i -m 3 --max-count 3 --max-filesize 500K -g '!*.lock' -g '!*.min.*' -- "${query.replace(/"/g, '\\"')}" | head -80`,
      { cwd: root, encoding: 'utf-8', timeout: 5000, maxBuffer: 512 * 1024 },
    );

    for (const rawLine of rgOutput.trim().split('\n').filter(Boolean)) {
      try {
        const parsed = JSON.parse(rawLine);
        if (parsed.type === 'match' && parsed.data) {
          const filePath = parsed.data.path?.text ?? '';
          const lineNum = parsed.data.line_number ?? 0;
          const lineText = parsed.data.lines?.text?.trim() ?? '';
          if (filePath && !results.some(r => r.file === filePath && r.line === lineNum)) {
            results.push({
              file: filePath,
              line: lineNum,
              text: lineText.slice(0, 200),
              matchType: 'code',
            });
          }
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* rg not found or no matches */ }

  // Dedupe: if a file appears as both filename and code match, keep code match
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  // Code matches first
  for (const r of results.filter(r => r.matchType === 'code')) {
    const key = `${r.file}:${r.line}`;
    if (!seen.has(key)) { seen.add(key); deduped.push(r); }
  }
  // Then filename matches that aren't already represented
  for (const r of results.filter(r => r.matchType === 'filename')) {
    if (!seen.has(r.file) && !deduped.some(d => d.file === r.file)) {
      deduped.push(r);
    }
  }

  return NextResponse.json({ results: deduped.slice(0, 20), query });
}
