import { NextRequest, NextResponse } from 'next/server';
import { isTrustedPanelRequest, requirePanelAuth } from '@/lib/panel/auth';
import { getUsageHistoryState } from '@/lib/usage/history-service';
import { getRemoteUsageHistoryState, savedUsageMachine, usageMachines } from '@/lib/usage/machine-history';
import { SavedMachineError } from '@/lib/panel/saved-ssh-machines';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request); if (denied) return denied;
  const machineId = request.nextUrl.searchParams.get('machine') ?? 'local';
  const inventory = request.nextUrl.searchParams.get('machines') === '1';
  if ((inventory || machineId !== 'local') && !isTrustedPanelRequest(request)) {
    return NextResponse.json({ error: 'Machine usage is available in the local app only.' }, { status: 403 });
  }
  if (inventory) {
    try { return NextResponse.json({ schema: 'o8/usage-machines/v1', machines: usageMachines() }, { headers: { 'Cache-Control': 'no-store' } }); }
    catch { return NextResponse.json({ error: 'Saved machines could not be read.' }, { status: 409 }); }
  }
  const days = Number(request.nextUrl.searchParams.get('days') ?? 30);
  const timeZone = request.nextUrl.searchParams.get('timeZone') ?? 'UTC';
  if (![1, 7, 30, 90].includes(days)) return NextResponse.json({ error: 'Choose a supported usage range.' }, { status: 400 });
  try { new Intl.DateTimeFormat('en', { timeZone }); }
  catch { return NextResponse.json({ error: 'Choose a valid time zone.' }, { status: 400 }); }
  try {
    const input = { days: days as 1 | 7 | 30 | 90, timeZone, fresh: request.nextUrl.searchParams.get('fresh') === '1' };
    const machine = machineId === 'local' ? { id: 'local', label: 'This machine' } : savedUsageMachine(machineId);
    const state = machineId === 'local' ? getUsageHistoryState(input) : getRemoteUsageHistoryState(machine as ReturnType<typeof savedUsageMachine>, input);
    if (state.snapshot) return NextResponse.json({ ...state.snapshot, refreshing: state.pending,
      refreshFailed: state.error, machine: { id: machine.id, label: machine.label } }, { headers: { 'Cache-Control': 'no-store' } });
    if (state.error) return NextResponse.json({ error: 'Machine history could not be read. Check SSH access and Node 22 on remote hosts.' }, { status: 503 });
    return NextResponse.json({ schema: 'o8/usage-history-state/v1', status: 'scanning', startedAt: state.startedAt, machine: { id: machine.id, label: machine.label } },
      { status: 202, headers: { 'Cache-Control': 'no-store', 'Retry-After': '2' } });
  } catch (error) {
    if (error instanceof SavedMachineError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: 'Machine usage history could not be read.' }, { status: 503 });
  }
}
