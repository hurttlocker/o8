import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseDirectiveFile } from '@/lib/cortex/directives/parse';
import { getDataDir } from '@/lib/data-dir-migration';
import type { SearchResult } from '@/lib/search/types';

export function searchDirectives(query: string, browse = false): SearchResult[] {
  const directivesDir = join(getDataDir(), 'directives');
  let files: string[];
  try {
    files = readdirSync(directivesDir).filter((file) => file.endsWith('.md'));
  } catch {
    return [];
  }

  const lowered = query.toLowerCase();
  const out: SearchResult[] = [];
  for (const file of files) {
    const filePath = join(directivesDir, file);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = parseDirectiveFile(raw, basename(file, '.md'));
      if (!parsed) continue;

      const title = parsed.title || parsed.id || file;
      const scope = parsed.scope || '';
      const body = parsed.body || '';
      const haystack = `${title}\n${scope}\n${parsed.repoName ?? ''}\n${body}`.toLowerCase();
      if (!browse && !haystack.includes(lowered)) continue;

      const detailParts: string[] = [];
      if (scope) detailParts.push(scope);
      if (parsed.repoName) detailParts.push(parsed.repoName);
      const bodyPreview = body.split('\n').find((line) => line.trim().length > 0)?.slice(0, 100) ?? '';
      if (bodyPreview) detailParts.push(bodyPreview);

      out.push({
        kind: 'directive',
        id: `directive:${parsed.id}`,
        title,
        detail: detailParts.join(' · ').slice(0, 140),
        target: { directiveId: parsed.id },
        score: browse
          ? parsed.priority ?? 0
          : 42
            + (title.toLowerCase().includes(lowered) ? 30 : 0)
            + (title.toLowerCase().startsWith(lowered) ? 20 : 0),
      });
      if (!browse && out.length >= 8) break;
    } catch {
      // Skip unparseable files.
    }
  }
  return out
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, browse ? 10 : 8);
}
