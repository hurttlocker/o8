export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import {
  IMessageMembershipChangedError,
  readIMessageAccessSettings,
  setIMessageBridgeEnabled,
  setIMessageExecutionBackend,
  setIMessageGroupFullAccess,
} from '@/lib/symon/imessage-access-settings';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  return NextResponse.json({ ok: true, ...readIMessageAccessSettings() });
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (body && 'executionBackend' in body) {
    if (body.executionBackend !== 'cli' && body.executionBackend !== 'openclaw') {
      return NextResponse.json({ ok: false, error: 'invalid_backend' }, { status: 400 });
    }
    try {
      const executionBackend = setIMessageExecutionBackend(body.executionBackend);
      if (!executionBackend) return NextResponse.json({ ok: false, error: 'openclaw_not_configured' }, { status: 409 });
      return NextResponse.json({ ok: true, executionBackend });
    } catch {
      return NextResponse.json({ ok: false, error: 'write_failed' }, { status: 500 });
    }
  }
  if (body && typeof body.enabled === 'boolean' && !('groupId' in body)) {
    try {
      const enabled = setIMessageBridgeEnabled(body.enabled);
      if (enabled === null) return NextResponse.json({ ok: false, error: 'bridge_not_configured' }, { status: 409 });
      return NextResponse.json({ ok: true, enabled });
    } catch {
      return NextResponse.json({ ok: false, error: 'write_failed' }, { status: 500 });
    }
  }
  if (!body || typeof body.groupId !== 'string' || typeof body.fullAccess !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }
  if (body.fullAccess && body.confirm !== 'grant-all-approved-members') {
    return NextResponse.json({ ok: false, error: 'confirmation_required' }, { status: 400 });
  }
  if (body.fullAccess && (typeof body.approvalVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.approvalVersion))) {
    return NextResponse.json({ ok: false, error: 'approval_version_required' }, { status: 400 });
  }
  try {
    const group = setIMessageGroupFullAccess(body.groupId, body.fullAccess, body.approvalVersion as string | undefined);
    if (!group) {
      return NextResponse.json({ ok: false, error: 'group_not_configured' }, { status: 409 });
    }
    return NextResponse.json({ ok: true, group });
  } catch (error) {
    if (error instanceof IMessageMembershipChangedError) {
      return NextResponse.json({ ok: false, error: 'membership_changed' }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: 'write_failed' }, { status: 500 });
  }
}
