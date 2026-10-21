export interface LinkedPullRequest {
  repo: string;
  number: number;
  title: string;
  linkedAt: string;
}
const PREFIX = 'o8:linked-pull-requests:v1:';
export const LINKED_PR_CHANGE_EVENT = 'o8:linked-pull-requests-changed';
const EMPTY: LinkedPullRequest[] = [];
const snapshots = new Map<string, { raw: string | null; links: LinkedPullRequest[] }>();

export function linkedPrIdentity(link: Pick<LinkedPullRequest, 'repo' | 'number'>) { return `${link.repo.toLowerCase()}#${link.number}`; }

export function readLinkedPullRequests(context: string): LinkedPullRequest[] {
  if (typeof window === 'undefined') return EMPTY;
  try {
    const raw = window.localStorage.getItem(PREFIX + context);
    const cached = snapshots.get(context);
    if (cached && cached.raw === raw) return cached.links;
    const parsed = JSON.parse(raw ?? '[]') as unknown;
    const links: LinkedPullRequest[] = [];
    const seen = new Set<string>();
    if (Array.isArray(parsed)) for (const entry of parsed.slice(0, 50)) {
      if (typeof entry?.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(entry.repo) || !Number.isSafeInteger(entry.number) || entry.number < 1 || typeof entry.title !== 'string' || typeof entry.linkedAt !== 'string') continue;
      const link = { repo: entry.repo.toLowerCase(), number: entry.number, title: entry.title.slice(0, 500), linkedAt: entry.linkedAt };
      if (!seen.has(linkedPrIdentity(link))) { links.push(link); seen.add(linkedPrIdentity(link)); }
    }
    snapshots.set(context, { raw, links });
    if (snapshots.size > 128) snapshots.delete(snapshots.keys().next().value!);
    return links;
  } catch { return EMPTY; }
}

export function saveLinkedPullRequests(context: string, links: LinkedPullRequest[]): void {
  if (links.length > 50) throw new Error('A conversation can save up to 50 linked pull requests.');
  window.localStorage.setItem(PREFIX + context, JSON.stringify(links));
  window.dispatchEvent(new CustomEvent(LINKED_PR_CHANGE_EVENT));
}

export function parsePullRequestLink(raw: string, defaultRepo: string | null): { repo: string; number: number } | null {
  const trimmed = raw.trim();
  const number = trimmed.match(/^#?([1-9]\d{0,6})$/);
  if (number && defaultRepo) return { repo: defaultRepo.toLowerCase(), number: Number(number[1]) };
  const url = trimmed.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d{0,6})(?:\/[\w/-]*|#[\w-]*)?$/i);
  return url ? { repo: url[1].toLowerCase(), number: Number(url[2]) } : null;
}
