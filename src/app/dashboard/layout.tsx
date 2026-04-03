import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getOrCreateWsToken } from '@/lib/ws-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return {
    other: {
      'ws-token': getOrCreateWsToken(),
    },
  };
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return children;
}
