import 'server-only';
import { githubInstallationFetch } from './auth';
import { checkBucket } from '@/components/desktop/pr-panel/check-status';
import type { RepairCheckEvidence } from '@/lib/github-client/check-repair-prompt';

export interface RepairCheck { key: string; name: string; url: string }
export async function readRepairChecks(repo: string, number: number) {
  const options = { signal: AbortSignal.timeout(18_000) };
  const metadata = await githubInstallationFetch(repo, `/repos/${repo}/pulls/${number}`, options);
  if (!metadata.response.ok) throw new Error('PR metadata unavailable');
  const pr = await metadata.response.json() as { state: string; merged_at?: string; head: { sha: string; ref: string; repo?: { full_name?: string } }; base: { ref: string } };
  if (pr.state !== 'open' || pr.merged_at || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(pr.head?.sha ?? '')) throw new Error('An open PR with a valid head is required');
  const result = await githubInstallationFetch(repo, `/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`, options);
  if (result.scope !== metadata.scope || !result.response.ok) throw new Error('Checks unavailable or authorization changed');
  const payload = await result.response.json() as { check_runs: Array<{ id: number; name: string; html_url?: string; status?: string; conclusion?: string }> };
  if (!Array.isArray(payload.check_runs)) throw new Error('Invalid checks response');
  const checks: RepairCheck[] = payload.check_runs.filter(check => Number.isSafeInteger(check.id) && typeof check.name === 'string' && checkBucket(check) === 'failing')
    .map(check => ({ key: String(check.id), name: check.name.slice(0, 180), url: check.html_url ?? '' }));
  return { headSha: pr.head.sha, branch: pr.head.ref, headRepo: pr.head.repo?.full_name ?? repo, baseBranch: pr.base.ref, scope: metadata.scope, checks };
}

/** Keep only the tail, with a hard download limit as well as a prompt limit. */
async function logTail(response: Response): Promise<string> {
  if (!response.ok || !response.body) return 'Job logs unavailable. Open the check URL for details.';
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let bytes = 0; let tail = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      tail = (tail + decoder.decode(value, { stream: true })).slice(-32_000);
      if (bytes > 4 * 1024 * 1024) return 'Job log exceeded the download budget. Open the check URL for full details.\n' + tail;
    }
    return tail + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}

export async function readRepairCheckEvidence(repo: string, headSha: string, scope: string, check: RepairCheck): Promise<RepairCheckEvidence> {
  const evidence = { name: check.name, workflow: 'External check', url: check.url, log: 'No GitHub Actions job logs are available for this check. Open its URL for details.' };
  let url: URL;
  try { url = new URL(check.url); } catch { return evidence; }
  const prefix = `/${repo}/actions/runs/`;
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.toLowerCase().startsWith(prefix.toLowerCase())) return evidence;
  const match = url.pathname.slice(prefix.length).match(/^\d+\/job\/(\d+)\/?$/);
  if (!match) return evidence;
  const path = `/repos/${repo}/actions/jobs/${match[1]}`;
  const options = { signal: AbortSignal.timeout(15_000) };
  const job = await githubInstallationFetch(repo, path, options);
  if (job.scope !== scope) throw new Error('GitHub authorization changed');
  if (!job.response.ok) return { ...evidence, log: 'Job metadata unavailable. Open the check URL for details.' };
  const data = await job.response.json() as { head_sha: string; workflow_name?: string };
  if (data.head_sha !== headSha) throw new Error('The check job belongs to a different head. Refresh checks.');
  evidence.workflow = data.workflow_name ?? 'GitHub Actions';
  const logs = await githubInstallationFetch(repo, `${path}/logs`, { ...options, redirect: 'manual' });
  if (logs.scope !== scope) throw new Error('GitHub authorization changed');
  if (logs.response.status === 302) {
    // GitHub supplies a short-lived signed download URL. Never forward its bearer.
    const location = new URL(logs.response.headers.get('location') ?? '');
    if (location.protocol !== 'https:' || location.username || location.password
      || !(location.hostname.endsWith('.blob.core.windows.net') || location.hostname.endsWith('.githubusercontent.com'))) throw new Error('Unexpected job log download location');
    evidence.log = await logTail(await fetch(location, { signal: options.signal, redirect: 'error', cache: 'no-store' }));
  } else evidence.log = await logTail(logs.response);
  return evidence;
}
