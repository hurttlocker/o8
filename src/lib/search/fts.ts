export function toFts5Query(query: string): string | null {
  const tokens = query
    .normalize('NFKC')
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.slice(0, 12) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' AND ');
}

export function matchedTextSnippet(text: string, query: string, maxLength = 150): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const lowered = normalized.toLowerCase();
  const queryLowered = query.trim().toLowerCase();
  let matchIndex = lowered.indexOf(queryLowered);
  if (matchIndex < 0) {
    const tokens = queryLowered.match(/[\p{L}\p{N}_-]+/gu) ?? [];
    matchIndex = tokens.reduce((best, token) => {
      const index = lowered.indexOf(token);
      if (index < 0) return best;
      return best < 0 ? index : Math.min(best, index);
    }, -1);
  }
  if (normalized.length <= maxLength) return normalized;
  if (matchIndex < 0) return `${normalized.slice(0, maxLength - 1)}…`;
  const before = Math.max(0, matchIndex - Math.floor(maxLength * 0.35));
  const after = Math.min(normalized.length, before + maxLength);
  return `${before > 0 ? '…' : ''}${normalized.slice(before, after)}${after < normalized.length ? '…' : ''}`;
}
