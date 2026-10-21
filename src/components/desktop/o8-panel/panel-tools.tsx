import { PageEdit } from 'iconoir-react';
import type { RightUtilityTab } from './types';

export type PanelToolGroup = 'Tools' | 'More' | 'Diagnostics';
export interface PanelToolDefinition {
  id: RightUtilityTab;
  label: string;
  description: string;
  group: PanelToolGroup;
  icon: (props: { size?: number }) => React.ReactNode;
}

export function PanelToolIcon({ tool, size = 16 }: { tool: RightUtilityTab; size?: number }) {
  if (tool === 'spec') return <PageEdit width={size} height={size} strokeWidth={1.6} />;
  const paths: Record<Exclude<RightUtilityTab, 'spec'>, React.ReactNode> = {
    files: <path d="M3 7V4h7l2 3h9v13H3V7h7" />,
    browser: <><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2c5 5 5 15 0 20-5-5-5-15 0-20Z" /></>,
    device: <><rect x="6" y="2" width="12" height="20" rx="3" /><path d="M10 5h4M11 19h2" /></>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M12 16h5" /></>,
    review: <><path d="m3 12 4 4L17 6M12 15l3 3 7-8" /></>,
    inbox: <><path d="M5 4h14l3 9v7H2v-7l3-9ZM2 13h6l2 3h4l2-3h6" /></>,
    threads: <><path d="M4 4h16v13H9l-5 4V4Z" /><path d="M8 9h8M8 13h5" /></>,
    activity: <path d="M2 12h4l3-9 6 18 3-9h4" />,
    'side-chat': <><circle cx="11" cy="13" r="8" /><path d="M19 2v6M16 5h6" /></>,
    resources: <><path d="M4 15a8 8 0 0 1 16 0M12 15l4-4" /><circle cx="12" cy="15" r="1" /></>,
    targets: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>{paths[tool]}</svg>;
}

function tool(id: RightUtilityTab, label: string, description: string, group: PanelToolGroup): PanelToolDefinition {
  return { id, label, description, group, icon: ({ size }) => <PanelToolIcon tool={id} size={size} /> };
}

/** One vocabulary for the drawer, launcher, and open tabs. PRs enter from the rail. */
export const PANEL_TOOLS: PanelToolDefinition[] = [
  tool('files', 'Files', 'Browse and read repository files', 'Tools'),
  tool('browser', 'Browser', 'Open websites and local previews', 'Tools'),
  tool('device', 'Devices', 'iOS simulators and Android emulators', 'Tools'),
  tool('terminal', 'Terminal', 'Run commands in an interactive shell', 'Tools'),
  tool('review', 'Review', 'Working changes across your project', 'Tools'),
  tool('inbox', 'Inbox', 'GitHub replies, approvals, and agent issues', 'Tools'),
  tool('spec', 'o8.md', 'Workspace notes and instructions', 'Tools'),
  tool('threads', 'Threads', 'Project tasks and agent exchanges', 'More'),
  tool('activity', 'Activity', 'Repository history and mission decisions', 'More'),
  tool('side-chat', 'Side chat', 'A separate conversation for this repository', 'More'),
  tool('resources', 'Resources', 'Live session CPU and memory', 'Diagnostics'),
  tool('targets', 'Targeting', 'Find code to direct your agents toward', 'Diagnostics'),
];

export const PANEL_TOOL_BY_ID = Object.fromEntries(PANEL_TOOLS.map((entry) => [entry.id, entry])) as Record<RightUtilityTab, PanelToolDefinition>;
