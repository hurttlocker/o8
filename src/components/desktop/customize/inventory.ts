import type { SkillInventoryEntry } from './SkillsInventoryTab';

export interface DirectiveSummary {
  id: string; title: string; scope: string; repoName: string | null;
  priority: number | null; body: string; projects: string[]; file: string | null;
}
export interface ExternalServer {
  id: string; name: string; transport: 'stdio' | 'http'; command?: string | null;
  url?: string | null; enabled?: boolean;
}
export interface AgentEntry {
  name: string; description: string | null; scope: 'user' | 'project'; file: string; repoName?: string;
}
export interface HookEntry {
  event: string; command: string; matcher: string | null; scope: 'user' | 'project'; file: string; repoName?: string;
}
export interface CustomizeRepo { name: string; localPath: string }
export interface CustomizeInventory {
  directives: DirectiveSummary[]; servers: ExternalServer[]; agents: AgentEntry[];
  hooks: HookEntry[]; skills: SkillInventoryEntry[];
}
export const emptyInventory: CustomizeInventory = { directives: [], servers: [], agents: [], hooks: [], skills: [] };
const unique = <T,>(items: T[], key: (item: T) => string) => [...new Map(items.map((item) => [key(item), item])).values()];

async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('Could not load customizations. Try again.');
  return response.json() as Promise<T>;
}

/** Read every selected repository; personal entries are returned once, never copied between repos. */
export async function loadCustomizeInventory(repos: CustomizeRepo[], personalOnly: boolean, signal: AbortSignal, projectId?: string): Promise<CustomizeInventory> {
  const scopes = repos.length ? repos : [null];
  const [inventories, rules, connections] = await Promise.all([
    Promise.all(scopes.map(async (repo) => {
      const data = await read<{ ok: boolean } & CustomizeInventory>(`/api/customize/inventory${repo ? `?repo=${encodeURIComponent(repo.localPath)}` : ''}`, signal);
      if (!data.ok) throw new Error('Could not load local customizations. Try again.');
      const identify = <T extends { scope: string }>(entry: T) => entry.scope === 'project' && repo
        ? { ...entry, repoName: repo.name, repoPath: repo.localPath } : entry;
      return { agents: (data.agents ?? []).map(identify), hooks: (data.hooks ?? []).map(identify), skills: (data.skills ?? []).map(identify) };
    })),
    Promise.all(scopes.map((repo) => {
      const params = new URLSearchParams();
      if (repo) params.set('repoPath', repo.localPath);
      if (projectId && !personalOnly) params.set('projectId', projectId);
      return read<{ directives: DirectiveSummary[] }>(`/api/cortex/directives?${params}`, signal);
    })),
    read<{ servers: ExternalServer[] }>('/api/setup/mcp-servers', signal),
  ]);
  return {
    directives: unique(rules.flatMap((data) => data.directives ?? []).filter((entry) => !personalOnly || !entry.scope || entry.scope === 'global'), (entry) => entry.id),
    servers: connections.servers ?? [],
    agents: unique(inventories.flatMap((data) => data.agents), (entry) => entry.file),
    hooks: unique(inventories.flatMap((data) => data.hooks), (entry) => `${entry.file}:${entry.event}:${entry.command}:${entry.matcher}`),
    skills: unique(inventories.flatMap((data) => data.skills), (entry) => entry.file),
  };
}
