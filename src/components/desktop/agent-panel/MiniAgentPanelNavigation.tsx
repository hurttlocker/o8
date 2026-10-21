'use client';

import { AutoFlash, ControlSlider, InputSearch } from 'iconoir-react';
import { MessageSquare, Terminal, type LucideIcon } from '../lucide-shims';
import { MiniAgentPanelAction } from '../MiniAgentPanelAction';

const SearchIcon: LucideIcon = ({ size = 24, strokeWidth = 2, color = 'currentColor' }) => <InputSearch width={size} height={size} strokeWidth={Number(strokeWidth)} color={color} />;
const AutomationsIcon: LucideIcon = ({ size = 24, strokeWidth = 2, color = 'currentColor' }) => <AutoFlash width={size} height={size} strokeWidth={Number(strokeWidth)} color={color} />;
const CustomizeIcon: LucideIcon = ({ size = 24, strokeWidth = 2, color = 'currentColor' }) => <ControlSlider width={size} height={size} strokeWidth={Number(strokeWidth)} color={color} />;

/** Existing compact-shell destinations. The desktop rail owns these instead. */
export function MiniAgentPanelNavigation({ onCreateTerminal, onSearch, onBeforeNavigate }: {
  onCreateTerminal?: () => void;
  onSearch?: () => void;
  onBeforeNavigate: () => void;
}) {
  const run = (action?: () => void) => { onBeforeNavigate(); action?.(); };
  const open = (event: string) => run(() => window.dispatchEvent(new CustomEvent(event)));
  return <>
    <MiniAgentPanelAction icon={Terminal} label="Terminal" onClick={() => run(onCreateTerminal)} disabled={!onCreateTerminal} />
    <MiniAgentPanelAction icon={SearchIcon} label="Search" onClick={() => run(onSearch)} disabled={!onSearch} />
    <MiniAgentPanelAction icon={MessageSquare} label="Handoffs" onClick={() => open('o8:open-handoffs')} />
    <MiniAgentPanelAction icon={AutomationsIcon} label="Automations" onClick={() => open('o8:open-automations')} />
    <MiniAgentPanelAction icon={CustomizeIcon} label="Customize" onClick={() => open('o8:open-customize')} />
  </>;
}
