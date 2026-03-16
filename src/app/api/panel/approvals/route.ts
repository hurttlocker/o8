import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Pending approvals store (in-memory for now).
 * Real approvals come from agent sessions; test approvals are injected here.
 */
export interface PendingApproval {
  id: string;
  agent: string;
  sessionKey: string;
  title: string;
  description: string;
  command?: string;
  risk: 'low' | 'medium' | 'high';
  createdAt: number;
  status: 'pending' | 'approved' | 'rejected';
}

// In-memory store — survives across requests within the same server process
const approvals = new Map<string, PendingApproval>();

/**
 * GET /api/panel/approvals — list pending approvals
 */
export async function GET() {
  const pending = Array.from(approvals.values())
    .filter(a => a.status === 'pending')
    .sort((a, b) => b.createdAt - a.createdAt);

  return NextResponse.json({ approvals: pending }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

/**
 * POST /api/panel/approvals — create test approval OR resolve one
 *
 * Create: { action: 'test' }
 * Resolve: { action: 'approve' | 'reject', id: string }
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = body.action as string;

  if (action === 'test') {
    const id = `approval-${Date.now()}`;
    const testApproval: PendingApproval = {
      id,
      agent: 'Niot',
      sessionKey: 'agent:ace:main',
      title: 'Execute shell command',
      description: 'Niot wants to run a potentially destructive command as part of the Cortex refactor task.',
      command: 'rm -rf node_modules && npm install && npm run build',
      risk: 'medium',
      createdAt: Date.now(),
      status: 'pending',
    };
    approvals.set(id, testApproval);
    return NextResponse.json({ ok: true, approval: testApproval });
  }

  if (action === 'approve' || action === 'reject') {
    const id = body.id as string;
    const approval = approvals.get(id);
    if (!approval) {
      return NextResponse.json({ ok: false, error: 'Approval not found' }, { status: 404 });
    }
    approval.status = action === 'approve' ? 'approved' : 'rejected';

    // In production, this would send the resolution to the agent's session
    // e.g. steerOpenClawSession(approval.sessionKey, `Approved: ${approval.title}`)

    return NextResponse.json({ ok: true, approval, resolved: action });
  }

  return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
}
