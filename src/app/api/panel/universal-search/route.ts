export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

const HOME = process.env.HOME || '/Users/marquisehurtt';
const CORTEX_BINARY = process.env.CORTEX_BINARY || `${HOME}/bin/cortex`;
const DEFAULT_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || `${HOME}/clawd/repos/cortex-ide`;
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const GATEWAY_PORT = process.env.OPENCLAW_GATEWAY_PORT || '18789';

// ── Result types ──

interface UniversalResult {
  kind: 'conversation' | 'agent' | 'memory' | 'issue' | 'file' | 'symbol';
  title: string;
  detail: string;
  /** Navigation target */
  target?: {
    sessionKey?: string;
    issueNumber?: number;
    filePath?: string;
    line?: number;
    factId?: number;
  };
  score: number;
}

// ── Helpers ──

function execQuiet(cmd: string, opts?: { cwd?: string; timeout?: number }): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: opts?.timeout ?? 4000,
      maxBuffer: 512 * 1024,
      cwd: opts?.cwd,
    }).trim();
  } catch {
    return '';
  }
}

// ── Symbol search (skeleton map) ──

function searchSymbolsProvider(query: string, workspace?: string): UniversalResult[] {
  try {
    // Dynamic import to avoid breaking if skeleton module isn't available
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { searchSymbols } = require('@/lib/skeleton') as typeof import('@/lib/skeleton');
    const root = workspace
      ? (workspace.startsWith('~') ? workspace.replace('~', HOME) : workspace)
      : DEFAULT_ROOT;
    const results = searchSymbols(root, query, 8);
    return results.map(r => ({
      kind: 'symbol' as const,
      title: `${r.symbol.exported ? 'export ' : ''}${r.symbol.kind} ${r.symbol.name}`,
      detail: `${r.filePath}:${r.symbol.line}`,
      target: { filePath: r.filePath, line: r.symbol.line },
      score: r.score * 0.85,
    }));
  } catch {
    return [];
  }
}

// ── Search providers ──

async function searchConversations(query: string): Promise<UniversalResult[]> {
  if (!GATEWAY_TOKEN) return [];
  const results: UniversalResult[] = [];
  try {
    // Use gateway to list recent sessions and grep their transcripts
    const raw = execQuiet(
      `curl -sf -H "Authorization: Bearer ${GATEWAY_TOKEN}" "http://127.0.0.1:${GATEWAY_PORT}/api/sessions?limit=20" 2>/dev/null`,
      { timeout: 3000 },
    );
    if (!raw) return [];
    const data = JSON.parse(raw);
    const sessions = data.sessions ?? data ?? [];

    for (const session of sessions.slice(0, 10)) {
      const key = session.key ?? session.sessionKey;
      if (!key) continue;
      // Fetch last 30 messages and grep
      try {
        const histRaw = execQuiet(
          `curl -sf -H "Authorization: Bearer ${GATEWAY_TOKEN}" "http://127.0.0.1:${GATEWAY_PORT}/api/sessions/${encodeURIComponent(key)}/history?limit=30" 2>/dev/null`,
          { timeout: 2000 },
        );
        if (!histRaw) continue;
        const hist = JSON.parse(histRaw);
        const messages = hist.messages ?? hist ?? [];
        const lowerQuery = query.toLowerCase();
        for (const msg of messages) {
          const content = typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content.map((c: { text?: string }) => c.text ?? '').join(' ')
              : '';
          if (content.toLowerCase().includes(lowerQuery)) {
            const snippet = extractSnippet(content, query, 120);
            results.push({
              kind: 'conversation',
              title: `${msg.role === 'user' ? 'You' : 'Agent'} in ${session.displayName ?? key}`,
              detail: snippet,
              target: { sessionKey: key },
              score: 0.7,
            });
            break; // One match per session
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* gateway unavailable */ }
  return results.slice(0, 5);
}

function searchMemory(query: string): UniversalResult[] {
  const raw = execQuiet(
    `"${CORTEX_BINARY}" search "${query.replace(/"/g, '\\"')}" --limit 5 --json 2>/dev/null`,
    { timeout: 3000 },
  );
  if (!raw) return [];
  try {
    const results = JSON.parse(raw);
    return (Array.isArray(results) ? results : []).slice(0, 5).map((r: {
      memory_id?: number;
      fact_ids?: number[];
      content?: string;
      snippet?: string;
      source_section?: string;
      score?: number;
    }) => {
      const title = r.source_section || (r.content ?? '').slice(0, 60);
      const detail = r.snippet || (r.content ?? '').slice(0, 120);
      return {
        kind: 'memory' as const,
        title: title.length > 60 ? title.slice(0, 57) + '…' : title,
        detail: detail.length > 120 ? detail.slice(0, 117) + '…' : detail,
        target: { factId: r.fact_ids?.[0] ?? r.memory_id },
        score: (r.score ?? 0.5) * 0.8,
      };
    });
  } catch {
    return [];
  }
}

function searchIssues(query: string): UniversalResult[] {
  const raw = execQuiet(
    `cd "${HOME}/clawd/repos/cortex-ide" && gh issue list --search "${query.replace(/"/g, '\\"')}" --json number,title,state,body --limit 8 2>/dev/null`,
    { timeout: 5000 },
  );
  if (!raw) return [];
  try {
    const issues = JSON.parse(raw);
    return (Array.isArray(issues) ? issues : []).map((i: { number: number; title: string; state: string; body?: string }) => ({
      kind: 'issue' as const,
      title: `#${i.number} ${i.title}`,
      detail: `${i.state} · ${(i.body ?? '').slice(0, 100)}`,
      target: { issueNumber: i.number },
      score: 0.75,
    }));
  } catch {
    return [];
  }
}

function searchFiles(query: string, workspace?: string): UniversalResult[] {
  const root = workspace
    ? (workspace.startsWith('~') ? workspace.replace('~', HOME) : workspace)
    : DEFAULT_ROOT;

  const results: UniversalResult[] = [];

  // Filename matches
  const findOut = execQuiet(
    `find . -maxdepth 5 -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/target/*' -not -path '*/dist/*' | grep -i "${query.replace(/"/g, '')}" | head -8`,
    { cwd: root, timeout: 3000 },
  );
  for (const line of findOut.split('\n').filter(Boolean)) {
    const clean = line.startsWith('./') ? line.slice(2) : line;
    results.push({
      kind: 'file',
      title: clean.split('/').pop() ?? clean,
      detail: clean,
      target: { filePath: clean },
      score: 0.8,
    });
  }

  // Content matches via ripgrep
  const rgOut = execQuiet(
    `rg --json -i -m 2 --max-filesize 500K -g '!*.lock' -g '!*.min.*' -- "${query.replace(/"/g, '\\"')}" | head -40`,
    { cwd: root, timeout: 4000 },
  );
  for (const rawLine of rgOut.split('\n').filter(Boolean)) {
    try {
      const parsed = JSON.parse(rawLine);
      if (parsed.type === 'match' && parsed.data) {
        const filePath = parsed.data.path?.text ?? '';
        const lineNum = parsed.data.line_number ?? 0;
        const lineText = (parsed.data.lines?.text ?? '').trim().slice(0, 200);
        if (filePath && !results.some(r => r.target?.filePath === filePath && r.target?.line === lineNum)) {
          results.push({
            kind: 'file',
            title: `${filePath.split('/').pop()}:${lineNum}`,
            detail: lineText,
            target: { filePath, line: lineNum },
            score: 0.65,
          });
        }
      }
    } catch { /* skip */ }
  }

  return results.slice(0, 10);
}

// ── Snippet extractor ──

function extractSnippet(text: string, query: string, maxLen: number): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, maxLen);
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + query.length + maxLen - 30);
  const snippet = text.slice(start, end);
  return (start > 0 ? '…' : '') + snippet + (end < text.length ? '…' : '');
}

// ── Main handler ──

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.trim();
  const workspace = searchParams.get('workspace') ?? undefined;
  const categories = searchParams.get('categories')?.split(',') ?? ['conversation', 'memory', 'issue', 'file', 'symbol'];

  if (!query || query.length < 2) {
    return NextResponse.json({ results: [], query: query ?? '', categories });
  }

  try {
    // Run searches in parallel
    // Agent search is done client-side to avoid oversized URLs (inventory is ~30KB)
    const searches = await Promise.allSettled([
      categories.includes('conversation') ? searchConversations(query) : Promise.resolve([]),
      categories.includes('memory') ? Promise.resolve(searchMemory(query)) : Promise.resolve([]),
      categories.includes('issue') ? Promise.resolve(searchIssues(query)) : Promise.resolve([]),
      categories.includes('file') ? Promise.resolve(searchFiles(query, workspace)) : Promise.resolve([]),
      categories.includes('symbol') ? Promise.resolve(searchSymbolsProvider(query, workspace)) : Promise.resolve([]),
    ]);

    const allResults: UniversalResult[] = [];
    for (const result of searches) {
      if (result.status === 'fulfilled') {
        allResults.push(...result.value);
      }
    }

    // Sort by score descending
    allResults.sort((a, b) => b.score - a.score);

    return NextResponse.json({
      results: allResults.slice(0, 25),
      query,
      categories,
    });
  } catch {
    return NextResponse.json(
      { results: [], query, error: 'Search failed', categories },
      { status: 500 },
    );
  }
}
