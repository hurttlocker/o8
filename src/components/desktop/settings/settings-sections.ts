import type { SettingsTab } from './shared';

// Preview major sections without mounting inactive tabs or loading their data.
// Once a tab is active, the menu reads its rendered section markers instead.
const SECTIONS: Partial<Record<SettingsTab, string[]>> = {
  general: ['Plan', 'Presentation', 'Privacy'],
  appearance: ['Theme'],
  'api-keys': ['PROVIDERS', 'STORAGE'],
  voice: ['Voice shortcuts', 'Symon', 'Permissions', 'Dictation', 'Transcription', 'Voice brain', 'Proactive attention'],
  permissions: ['macOS permissions'],
  'operator-defaults': ['Fleet', 'Supervision', 'Orchestrator', 'Dispatch runtime', 'Retention', 'Workspace parking', 'Dispatch reserve', 'Worktree storage', 'Storage categories', 'Advanced routing', 'Model tiers', 'Brain routing', 'Local models'],
  models: ['Runtime routing', 'Runtimes', 'Claude Code harness', 'Engineering Brain', 'OpenCode 2 models', '3code worker', 'Orchestrator', 'Metered packet limits', 'API keys', 'Local models'],
  projects: ['Overview', 'Runtime context'],
  'git-prs': ['GitHub', 'Branches', 'Commits', 'Pull requests'],
  indexing: ['Repositories', 'Engineering Brain'],
  mcp: ['Clients', 'External servers', 'Diagnostics'],
  connections: ['Remote access', 'Symon Messages', 'Pairing', 'Paired devices'],
  billing: ['Current plan'],
  analytics: ['TOTALS', 'SPEND OVER TIME', 'BY SURFACE'],
  diagnostics: ['Runtimes', 'Shipped feature audit', 'Maintenance', 'Danger'],
  about: ['Version', 'Links', 'Onboarding', 'Report an issue', 'Credits'],
};

export function settingsSectionPreview(tab: SettingsTab, desktop: boolean): string[] {
  if (!desktop && (tab === 'voice' || tab === 'permissions')) return [];
  if (desktop && tab === 'general') return ['Plan', 'Startup', 'Presentation', 'Privacy'];
  return SECTIONS[tab] ?? [];
}

export function renderedSettingsSections(root: ParentNode): string[] {
  return [...new Set(Array.from(root.querySelectorAll<HTMLElement>('[data-settings-section]'))
    .map((element) => element.dataset.settingsSection).filter((label): label is string => Boolean(label)))];
}
