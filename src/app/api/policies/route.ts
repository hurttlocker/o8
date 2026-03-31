import { NextRequest, NextResponse } from 'next/server';
import { parsePolicyRules, writeUserPolicies } from '@/lib/approvals/policy-loader';
import { listPolicySummaries, refreshPolicyRules } from '@/lib/approvals/policies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function policyResponseHeaders() {
  return { 'Cache-Control': 'no-store, max-age=0' };
}

export async function GET() {
  return NextResponse.json(
    { policies: listPolicySummaries() },
    { headers: policyResponseHeaders() },
  );
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const rawPolicies = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { policies?: unknown }).policies)
      ? (body as { policies: unknown[] }).policies
      : null;

  if (!rawPolicies) {
    return NextResponse.json(
      { ok: false, error: 'policies array is required' },
      { status: 400, headers: policyResponseHeaders() },
    );
  }

  const parsed = parsePolicyRules(rawPolicies);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: parsed.error ?? 'Invalid policies payload' },
      { status: 400, headers: policyResponseHeaders() },
    );
  }

  try {
    writeUserPolicies(parsed.rules);
    const policies = refreshPolicyRules();
    return NextResponse.json(
      { ok: true, policies },
      { headers: policyResponseHeaders() },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to write policies file';
    console.error(`[policy] ${message}`);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500, headers: policyResponseHeaders() },
    );
  }
}
