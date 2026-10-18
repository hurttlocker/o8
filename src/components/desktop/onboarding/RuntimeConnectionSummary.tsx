'use client';

import { connectionDetail, connectionLabel, type RuntimeConnectionEvidence } from '@/lib/runtimes/shared/connection-evidence';

export function RuntimeConnectionSummary({ connection }: { connection?: RuntimeConnectionEvidence }) {
  return <div data-testid="runtime-connection-evidence" style={{ fontSize: 11, fontWeight: 300, lineHeight: 1.5, color: 'var(--t-text-muted)', overflowWrap: 'anywhere' }}>
    <div>{connection ? connectionLabel(connection) : 'Connection evidence unavailable'}</div>
    <div>{connection ? connectionDetail(connection) : 'Refresh the runtime check to try again.'}</div>
    <div>{connection?.checkedAt ? `Checked ${new Date(connection.checkedAt).toISOString()}` : 'Check time not reported'}</div>
    <div>Account identity not reported · External tools not inspected</div>
  </div>;
}
