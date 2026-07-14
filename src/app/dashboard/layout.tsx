import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { ApiBearerBootstrap } from '@/components/security/ApiBearerBootstrap';

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
  return <><ApiBearerBootstrap source="meta" />{children}</>;
}
