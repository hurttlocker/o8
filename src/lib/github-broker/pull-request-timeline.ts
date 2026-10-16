import 'server-only';

import { githubInstallationFetch } from './auth';
import type { PrTimelineEvent, PrTimelinePage } from '@/components/desktop/pr-panel/types';

interface TimelineEvent {
  id?: number;
  event?: string;
  sha?: string;
  actor?: { login?: string; avatar_url?: string };
  user?: { login?: string; avatar_url?: string };
  author?: { name?: string; date?: string };
  created_at?: string;
  submitted_at?: string;
  html_url?: string;
  body?: string;
  message?: string;
  state?: string;
  label?: { name?: string };
  rename?: { from?: string; to?: string };
  requested_reviewer?: { login?: string };
  requested_team?: { name?: string };
}

function eventTitle(event: TimelineEvent): string {
  switch (event.event) {
    case 'committed': return event.message?.split('\n')[0] || 'Committed changes';
    case 'commented': return 'commented';
    case 'reviewed': return event.state === 'approved' ? 'approved these changes' : event.state === 'changes_requested' ? 'requested changes' : 'reviewed these changes';
    case 'labeled': return `added ${event.label?.name || 'a label'}`;
    case 'unlabeled': return `removed ${event.label?.name || 'a label'}`;
    case 'review_requested': return `requested a review${event.requested_reviewer?.login || event.requested_team?.name ? ` from ${event.requested_reviewer?.login || event.requested_team?.name}` : ''}`;
    case 'review_request_removed': return 'removed a review request';
    case 'renamed': return `renamed this pull request${event.rename?.to ? ` to ${event.rename.to}` : ''}`;
    case 'head_ref_force_pushed': return 'force-pushed the branch';
    case 'head_ref_deleted': return 'deleted the branch';
    case 'head_ref_restored': return 'restored the branch';
    case 'ready_for_review': return 'marked this ready for review';
    case 'convert_to_draft': return 'converted this to a draft';
    case 'merged': return 'merged this pull request';
    case 'closed': return 'closed this pull request';
    case 'reopened': return 'reopened this pull request';
    default: return (event.event || 'Activity').replaceAll('_', ' ');
  }
}

export async function fetchPullRequestTimelinePage(repo: string, number: number, page: number, signal?: AbortSignal): Promise<PrTimelinePage> {
  const { response } = await githubInstallationFetch(repo, `/repos/${repo}/issues/${number}/timeline?per_page=100&page=${page}`, { signal });
  if (!response.ok) throw new Error(`Pull request activity could not be loaded (${response.status}).`);
  const entries = await response.json() as TimelineEvent[];
  const events = entries.map((event, index): PrTimelineEvent => {
    const actor = event.actor || event.user;
    const id = String(event.id ?? event.sha ?? `${page}-${index}`);
    return {
      id: `${event.event || 'activity'}:${id}`,
      kind: event.event || 'activity',
      title: eventTitle(event),
      actor: actor?.login || event.author?.name || 'GitHub',
      avatarUrl: actor?.avatar_url || null,
      at: event.created_at || event.submitted_at || event.author?.date || '',
      body: event.body || '',
      url: event.html_url || (event.sha ? `https://github.com/${repo}/commit/${event.sha}` : `https://github.com/${repo}/pull/${number}#event-${event.id ?? ''}`),
      ...(event.sha ? { commitSha: event.sha } : {}),
    };
  });
  const hasNext = (response.headers.get('link') || '').split(',').some((link) => /rel="next"/.test(link));
  return { events, nextPage: hasNext ? page + 1 : null };
}
