import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { listRepos } from '@/lib/repos/registry';
import { normalizeRepoSlug } from '@/lib/github-broker/repo';
import { readRepairChecks, readRepairCheckEvidence } from '@/lib/github-broker/check-repair';
import { buildCheckRepairPrompt, MAX_REPAIR_CHECKS } from '@/lib/github-client/check-repair-prompt';
import { findPrRepairOwner } from '@/lib/orchestrator/pr-repair-owner';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ number: string }> };
async function prepare(request: NextRequest, context: Context, launch: boolean) {
  if (resolveRequestPrincipal(request) !== 'operator') return NextResponse.json({ ok: false, error: 'Operator authority is required.' }, { status: 403 });
  const number = Number((await context.params).number);
  const repo = new URL(request.url).searchParams.get('repo') ?? '';
  if (!Number.isSafeInteger(number) || number <= 0 || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return NextResponse.json({ ok: false, error: 'A repository and PR number are required.' }, { status: 400 });
  const body = launch ? await request.json().catch(() => null) : null;
  if (launch && (!body || typeof body.expectedHeadSha !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(body.expectedHeadSha)
    || typeof body.clientMutationId !== 'string' || !body.clientMutationId.trim() || body.clientMutationId.length > 200
    || !Array.isArray(body.checks) || body.checks.length < 1 || body.checks.length > MAX_REPAIR_CHECKS
    || body.checks.some((key: unknown) => typeof key !== 'string') || new Set(body.checks).size !== body.checks.length)) return NextResponse.json({ ok: false, error: 'Select between one and twelve failed checks with their current head.' }, { status: 400 });
  try {
    const local = (await listRepos()).find(entry => normalizeRepoSlug(entry.remoteUrl)?.toLowerCase() === repo.toLowerCase());
    if (!local) return NextResponse.json({ ok: false, error: 'Register this repository locally before starting a repair.' }, { status: 409 });
    const owner = findPrRepairOwner(local.localPath, number);
    if (owner) return NextResponse.json({ ok: false, code: 'pr_has_owner', ownerLaneId: owner.id, error: 'This PR has an owning worker. Send the failing checks to that worker instead.' }, { status: 409 });
    const snapshot = await readRepairChecks(repo, number);
    if (!launch) return NextResponse.json({ ok: true, headSha: snapshot.headSha, branch: snapshot.branch, checks: snapshot.checks });
    if (snapshot.headSha !== body.expectedHeadSha) return NextResponse.json({ ok: false, code: 'stale_pr_head', error: 'The PR head changed. Refresh checks and select the failures again.' }, { status: 409 });
    const selected = snapshot.checks.filter(check => body.checks.includes(check.key));
    if (selected.length !== body.checks.length) return NextResponse.json({ ok: false, code: 'stale_checks', error: 'The selected checks changed. Refresh checks and select the failures again.' }, { status: 409 });
    const checks = await Promise.all(selected.map(check => readRepairCheckEvidence(repo, snapshot.headSha, snapshot.scope, check)));
    return NextResponse.json({ ok: true, delegation: {
      clientMutationId: body.clientMutationId, repoPath: local.localPath, taskName: `Fix checks for ${repo}#${number}`,
      prompt: buildCheckRepairPrompt({ repo, headRepo: snapshot.headRepo, number, branch: snapshot.branch, headSha: snapshot.headSha, checks }),
      readOnly: false, isolate: true, repairPullRequest: number, expectedRepairHeadSha: snapshot.headSha,
      baseBranch: snapshot.baseBranch,
    } });
  } catch {
    return NextResponse.json({ ok: false, error: 'Checks or job logs could not be read. Check GitHub access and retry.' }, { status: 502 });
  }
}
export function GET(request: NextRequest, context: Context) { return prepare(request, context, false); }
export function POST(request: NextRequest, context: Context) { return prepare(request, context, true); }
