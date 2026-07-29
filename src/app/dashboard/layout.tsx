import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { headersIndicateLoopback } from '@/lib/auth/loopback-request';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { ApiBearerBootstrap } from '@/components/security/ApiBearerBootstrap';
import { headersIndicateWebMachineRelay } from '@/lib/connect/web-machine-surface';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  // Only embed the ws-token for loopback page loads (desktop webview, dev). This page
  // used to be unreachable from anywhere else, so it embedded the master credential
  // unconditionally — once the machine bridge could serve it, the connector's
  // credential-leak guard (correctly) killed every dashboard response, which surfaced
  // as a bare 502 in the browser. Relayed loads authenticate through the tunnel the
  // connector installed instead; see @/lib/connect/web-machine-surface.
  const h = await headers();
  const isWebMachine = headersIndicateWebMachineRelay((name) => h.get(name));
  const isLocal = !isWebMachine && headersIndicateLoopback((name) => h.get(name));
  return {
    other: {
      ...(isLocal ? { 'ws-token': getOrCreateWsToken() } : {}),
    },
  };
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <><ApiBearerBootstrap source="meta" />{children}</>;
}
