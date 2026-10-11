'use client';

import { useId, type ReactNode } from 'react';
import { SectionLabel } from './shared';
import { useCollapsedShelf } from './use-collapsed-shelf';

export function ChatHistoryShelf({ label, count, storageKey, initiallyCollapsed = false, action, children }: {
  label: string;
  count?: number;
  storageKey?: string;
  initiallyCollapsed?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [collapsed, toggle] = useCollapsedShelf(storageKey ?? `o8:chat-${label.toLowerCase()}-collapsed`, initiallyCollapsed);
  const id = useId();
  return <section aria-label={`${label} conversations`}>
    <SectionLabel label={label} compact count={count} collapsed={collapsed} onToggle={toggle} action={action} controls={id} />
    {!collapsed ? <div id={id}>{children}</div> : null}
  </section>;
}
