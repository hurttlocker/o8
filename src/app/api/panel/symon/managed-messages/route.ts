export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import {
  disableManagedMessageChannel,
  enableManagedMessageChannel,
  getManagedMessageChannel,
} from '@/lib/connect/managed-messages';
import { listMachines } from '@/lib/connect/machine-registry';
import {
  readConnectAttachSetting,
  writeConnectAttachEnabled,
} from '@/lib/connect/attach-settings';
import { getOrCreateInstallId } from '@/lib/entitlement/bootstrap';
import { readCachedEntitlement } from '@/lib/entitlement/license';
import { requirePanelAuth } from '@/lib/panel/auth';

function credential(request: NextRequest): string {
  return request.headers.get('x-clerk-session-token')?.trim()
    || readCachedEntitlement()?.licenseKey?.trim()
    || '';
}

function errorMessage(code: string): string {
  if (code === 'managed_plan_required') return 'Managed Messages requires an o8 managed-service plan.';
  if (code === 'no_numbers_available') return 'No managed numbers are available right now.';
  if (code === 'not_configured') return 'Managed Messages is not available on this o8 service yet.';
  if (code === 'machine_not_found') return 'Connect this Mac to o8 before enabling managed Messages.';
  if (code === 'attach_locked_off') return 'O8_CONNECT_ATTACH currently prevents this Mac from connecting.';
  if (code === 'auth_required' || code === 'unauthorized') return 'Sign in to o8 before enabling managed Messages.';
  return 'Managed Messages is temporarily unavailable.';
}

async function currentMachineId(token: string): Promise<string | null> {
  const machines = await listMachines({ token });
  if (!machines.ok) return null;
  const installId = getOrCreateInstallId();
  return machines.data.find((machine) => machine.installId === installId)?.machineId ?? null;
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const token = credential(request);
  if (!token) {
    return NextResponse.json({
      ok: false,
      error: 'auth_required',
      message: errorMessage('auth_required'),
    }, { status: 401 });
  }
  const [channel, machineId] = await Promise.all([
    getManagedMessageChannel(token),
    currentMachineId(token),
  ]);
  if (!channel.ok) {
    return NextResponse.json({
      ok: false,
      error: channel.error,
      message: errorMessage(channel.error),
    }, { status: channel.status });
  }
  return NextResponse.json({ ok: true, ...channel.data, connected: machineId !== null });
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const token = credential(request);
  if (!token) {
    return NextResponse.json({
      ok: false,
      error: 'auth_required',
      message: errorMessage('auth_required'),
    }, { status: 401 });
  }
  const payload = await request.json().catch(() => null) as {
    enabled?: unknown;
    allowedSenderHandle?: unknown;
  } | null;
  if (typeof payload?.enabled !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }
  if (!payload.enabled) {
    const disabled = await disableManagedMessageChannel(token);
    if (!disabled.ok) {
      return NextResponse.json({
        ok: false,
        error: disabled.error,
        message: errorMessage(disabled.error),
      }, { status: disabled.status });
    }
    return NextResponse.json({ ok: true, ...disabled.data, connected: true });
  }

  const machineId = await currentMachineId(token);
  if (!machineId) {
    return NextResponse.json({
      ok: false,
      error: 'machine_not_found',
      message: errorMessage('machine_not_found'),
    }, { status: 409 });
  }
  const attach = readConnectAttachSetting();
  if (attach.locked && !attach.enabled) {
    return NextResponse.json({
      ok: false,
      error: 'attach_locked_off',
      message: errorMessage('attach_locked_off'),
    }, { status: 409 });
  }
  const allowedSenderHandle = typeof payload.allowedSenderHandle === 'string'
    ? payload.allowedSenderHandle.trim().replace(/[().\s-]/g, '')
    : '';
  if (!/^\+[1-9]\d{6,14}$/.test(allowedSenderHandle)) {
    return NextResponse.json({
      ok: false,
      error: 'invalid_sender',
      message: 'Enter the phone number you will text from, including country code.',
    }, { status: 400 });
  }
  const enabled = await enableManagedMessageChannel(token, machineId, allowedSenderHandle);
  if (!enabled.ok) {
    return NextResponse.json({
      ok: false,
      error: enabled.error,
      message: errorMessage(enabled.error),
    }, { status: enabled.status });
  }
  if (!attach.locked) writeConnectAttachEnabled(true);
  return NextResponse.json({ ok: true, ...enabled.data, connected: true });
}
