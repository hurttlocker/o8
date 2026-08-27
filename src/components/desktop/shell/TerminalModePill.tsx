'use client';

import { Expand } from '@/components/desktop/lucide-shims';
import { HeaderIconPill } from '@/components/desktop/shell/HeaderIconPill';

export const TERMINAL_MODE_TOGGLE_EVENT = 'o8:request-toggle-terminal-mode';

export function requestTerminalModeToggle(workspaceId?: string | null) {
  window.dispatchEvent(new CustomEvent(TERMINAL_MODE_TOGGLE_EVENT, {
    detail: { workspaceId: workspaceId ?? null },
  }));
}

export function TerminalModePill({
  active,
  workspaceId,
  paneLabel,
}: {
  active: boolean;
  workspaceId: string;
  paneLabel?: string;
}) {
  const action = active ? 'Exit Terminal Mode' : 'Enter Terminal Mode';
  const label = paneLabel ? `${action} (${paneLabel})` : action;
  return (
    <HeaderIconPill
      icon={<Expand size={15} strokeWidth={1.9} />}
      label={label}
      title={`${action} (⌘⇧J)`}
      onClick={() => requestTerminalModeToggle(workspaceId)}
      yNudge={1.3}
    />
  );
}
