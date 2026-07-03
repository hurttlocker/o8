export function parsePullRequestNumber(output: string): number | null {
  const trimmed = output.trim();
  const urlMatch = trimmed.match(/\/pull\/(\d+)(?:\b|[/?#])/);
  if (urlMatch?.[1]) return Number(urlMatch[1]);

  const hashMatch = trimmed.match(/#(\d+)\b/);
  if (hashMatch?.[1]) return Number(hashMatch[1]);

  const numeric = Number(trimmed);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}
