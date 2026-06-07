'use client';

/**
 * <Gate flag="..."> — renders children only when the entitlement flag is on,
 * otherwise renders `fallback` (or null). Tiny, pure. No feature is wired to a
 * Gate yet (M2 ships the primitive; gating lands in later milestones).
 */

import { useEntitlement } from './context';
import type { EntitlementFlags } from './types';

interface GateProps {
  flag: keyof EntitlementFlags;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

export function Gate({ flag, fallback = null, children }: GateProps) {
  const { flags } = useEntitlement();
  return <>{flags[flag] ? children : fallback}</>;
}
