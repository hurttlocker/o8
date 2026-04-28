/**
 * /dispatch-popover — the 600x80 frameless popover summoned by Cmd+Shift+O
 * (issue #730). Renders DispatchPopover.tsx and inherits the dashboard's
 * ws-token via metadata so cross-origin auth works inside the secondary
 * Tauri webview.
 */
import type { Metadata } from 'next';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import DispatchPopover from '@/components/desktop/DispatchPopover';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return {
    title: 'o8 — Quick Dispatch',
    other: {
      'ws-token': getOrCreateWsToken(),
    },
  };
}

export default function DispatchPopoverPage() {
  return <DispatchPopover />;
}
