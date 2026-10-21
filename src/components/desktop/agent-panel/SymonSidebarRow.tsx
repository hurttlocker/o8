'use client';

import { MiniAgentPanelAction } from '../MiniAgentPanelAction';
import { SymonIcon } from './SidebarActionIcons';

/** Uses the same user-initiated voice action as the existing sidebar control. */
export function SymonSidebarRow() {
  return <MiniAgentPanelAction
    icon={SymonIcon}
    label="Symon"
    onClick={() => window.dispatchEvent(new Event('o8:symon-voice-toggle'))}
  />;
}
