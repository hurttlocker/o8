export type DiffCategory = 'Code' | 'Tests' | 'Mocks' | 'Other';
type FileCounts = { path: string; previousPath?: string | null; additions: number; deletions: number };
export type DiffCategoryRow = { category: DiffCategory; files: number; additions: number; deletions: number };

/** Path-based estimates, not a semantic analysis. Mocks/fixtures take precedence over tests. */
export function classifyDiffPath(path: string): DiffCategory {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const name = normalized.split('/').at(-1) ?? '';
  if (/(^|\/)(__mocks__|mocks?|__fixtures__|fixtures)(\/|$)/.test(normalized)
    || /(^mock[_-]|[._-](mock|fixture)s?\.)/.test(name)) return 'Mocks';
  if (/(^|\/)(__tests__|tests?|specs?|e2e)(\/|$)/.test(normalized)
    || /(^test[_-]|[._-](test|spec)\.)/.test(name)) return 'Tests';
  if (/\.(c|cc|cpp|cxx|h|hpp|cs|css|scss|sass|less|go|rs|py|pyi|rb|php|swift|m|mm|kt|kts|java|js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|html|sh|bash|zsh|fish|ps1|sql|graphql|gql|ex|exs|erl|hrl|clj|cljs|hs|lua|r|dart|scala|sc|pl|pm|zig)$/i.test(name)) {
    return 'Code';
  }
  return 'Other';
}

export function buildDiffBreakdown(files: readonly FileCounts[], totalFiles: number, additions: number, deletions: number) {
  const rows: DiffCategoryRow[] = (['Code', 'Tests', 'Mocks', 'Other'] as const)
    .map(category => ({ category, files: 0, additions: 0, deletions: 0 }));
  for (const file of files) {
    const row = rows.find(row => row.category === classifyDiffPath(file.path))!;
    row.files += 1; row.additions += file.additions; row.deletions += file.deletions;
  }
  const loaded = rows.reduce((sum, row) => ({ additions: sum.additions + row.additions, deletions: sum.deletions + row.deletions }), { additions: 0, deletions: 0 });
  return {
    rows: rows.filter(row => row.files > 0), loaded,
    complete: files.length === totalFiles && loaded.additions === additions && loaded.deletions === deletions,
  };
}
