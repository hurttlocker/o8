'use client';

/**
 * CustomizePage — first-class customization inventory (operator ask
 * 2026-07-13, vid3 Cursor study: left-rail "Customize" under Automations →
 * a full-page takeover with scope pill + tab pills + sectioned lists).
 *
 * Cursor mechanics carried over: instant tab swap, sectioned lists with
 * counts, hover-fill rows, metadata pills, instructive empty states,
 * click-throughs. o8 divergences (honest, no placeholder data): tabs map to
 * what o8 actually has — Rules (Cortex directives), Connections (MCP
 * servers), Commands (slash registry), Agents (.claude/agents), Hooks
 * (settings.json) — and there is no marketplace button until a marketplace
 * exists. Read-only inventory: editing happens where each artifact lives
 * (Connections click through to Settings → MCP).
 *
 * Mounted from dashboard/page.tsx when activeNavSection === 'customize'
 * (same page-takeover pattern as AutomationsPage).
 */

import { useEffect, useMemo, useState } from 'react';
import { ORCHESTRATOR_SLASH_COMMANDS } from '@/lib/slash-commands/definitions';
import { OPEN_SETTINGS_TAB_EVENT } from '@/lib/desktop/events';

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = 'var(--font-mono, "SF Mono", Menlo, monospace)';

type CustomizeTab = 'rules' | 'connections' | 'commands' | 'agents' | 'hooks';

const TABS: Array<{ id: CustomizeTab; label: string }> = [
  { id: 'rules', label: 'Rules' },
  { id: 'connections', label: 'Connections' },
  { id: 'commands', label: 'Commands' },
  { id: 'agents', label: 'Agents' },
  { id: 'hooks', label: 'Hooks' },
];

interface DirectiveSummary {
  id: string;
  title: string;
  scope: string;
  repoName: string | null;
  priority: number | null;
  body: string;
  projects: string[];
}

interface ExternalServer {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string | null;
  url?: string | null;
  enabled?: boolean;
}

interface AgentEntry {
  name: string;
  description: string | null;
  scope: 'user' | 'project';
  file: string;
}

interface HookEntry {
  event: string;
  command: string;
  matcher: string | null;
  scope: 'user' | 'project';
}

interface RegisteredRepoLite {
  name: string;
  localPath: string;
}

/** o8's own always-on MCP servers — shown so "all connections" is honest. */
const BUILTIN_CONNECTIONS: Array<{ name: string; detail: string }> = [
  { name: 'o8 operator', detail: 'Missions, approvals, webview control — the operator MCP surface' },
  { name: 'cortex', detail: 'Fleet, issues, PRs — internal orchestrator tools' },
  { name: 'codebase-memory', detail: 'Repo knowledge graph and code search' },
];

function openSettingsMcpTab() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_TAB_EVENT, { detail: { tab: 'mcp' } }));
}

export function CustomizePage({ onClose }: { onClose?: () => void }) {
  const [tab, setTab] = useState<CustomizeTab>('rules');
  const [query, setQuery] = useState('');
  const [repos, setRepos] = useState<RegisteredRepoLite[]>([]);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);

  const [directives, setDirectives] = useState<DirectiveSummary[]>([]);
  const [servers, setServers] = useState<ExternalServer[]>([]);
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [hooks, setHooks] = useState<HookEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/panel/repos');
        if (!response.ok || cancelled) return;
        const data = await response.json() as { repos?: Array<{ name?: string; localPath?: string }> };
        const list = (data.repos ?? [])
          .filter((repo): repo is { name: string; localPath: string } => Boolean(repo?.name && repo?.localPath))
          .map((repo) => ({ name: repo.name, localPath: repo.localPath }));
        if (cancelled) return;
        setRepos(list);
        setRepoPath((current) => current ?? list[0]?.localPath ?? null);
      } catch { /* rail still renders; sections show their empty states */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const [directivesRes, serversRes, inventoryRes] = await Promise.allSettled([
        fetch('/api/cortex/directives').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/setup/mcp-servers').then((r) => (r.ok ? r.json() : null)),
        fetch(`/api/customize/inventory${repoPath ? `?repo=${encodeURIComponent(repoPath)}` : ''}`).then((r) => (r.ok ? r.json() : null)),
      ]);
      if (cancelled) return;
      if (directivesRes.status === 'fulfilled' && directivesRes.value?.directives) {
        setDirectives(directivesRes.value.directives as DirectiveSummary[]);
      }
      if (serversRes.status === 'fulfilled' && serversRes.value?.servers) {
        setServers(serversRes.value.servers as ExternalServer[]);
      }
      if (inventoryRes.status === 'fulfilled' && inventoryRes.value?.ok) {
        setAgents(inventoryRes.value.agents as AgentEntry[]);
        setHooks(inventoryRes.value.hooks as HookEntry[]);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [repoPath]);

  const activeRepoName = useMemo(
    () => repos.find((repo) => repo.localPath === repoPath)?.name ?? 'All repos',
    [repos, repoPath],
  );

  const q = query.trim().toLowerCase();
  const matches = (...fields: Array<string | null | undefined>) =>
    !q || fields.some((field) => field?.toLowerCase().includes(q));

  const searchNoun = TABS.find((t) => t.id === tab)?.label ?? 'customizations';

  return (
    <div style={{
      height: '100%',
      minHeight: 0,
      overflowY: 'auto',
      background: 'var(--t-chat-surface-bg, var(--t-canvas-bg))',
      fontFamily: UI_FONT,
    }} className="cortex-themed-scroll">
      <div style={{
        width: '100%',
        maxWidth: 760,
        marginLeft: 'auto',
        marginRight: 'auto',
        paddingTop: 36,
        paddingBottom: 64,
        paddingLeft: 24,
        paddingRight: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}>
        {/* Search row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingTop: 7,
            paddingBottom: 7,
            paddingLeft: 11,
            paddingRight: 11,
            borderRadius: 9,
            background: 'var(--t-input-bg)',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider-subtle)',
          }}>
            <SearchGlyph />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${searchNoun} for ${activeRepoName}…`}
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: 12.5,
                fontFamily: UI_FONT,
                color: 'var(--t-text)',
              }}
            />
          </div>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Customize"
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--t-text-muted)',
                fontSize: 12,
                cursor: 'pointer',
                paddingTop: 6,
                paddingBottom: 6,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 8,
              }}
            >
              Done
            </button>
          ) : null}
        </div>

        {/* Scope pill + tab pills */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', position: 'relative' }}>
          <button
            type="button"
            onClick={() => setRepoMenuOpen((open) => !open)}
            aria-expanded={repoMenuOpen}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              paddingTop: 4,
              paddingBottom: 4,
              paddingLeft: 10,
              paddingRight: 8,
              borderRadius: 8,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-divider)',
              background: 'transparent',
              color: 'var(--t-text)',
              fontSize: 12,
              fontFamily: UI_FONT,
              cursor: 'pointer',
            }}
          >
            {activeRepoName}
            <ChevronDownGlyph />
          </button>
          {repoMenuOpen ? (
            <div style={{
              position: 'absolute',
              top: 32,
              left: 0,
              zIndex: 30,
              minWidth: 200,
              display: 'flex',
              flexDirection: 'column',
              paddingTop: 4,
              paddingBottom: 4,
              borderRadius: 10,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-divider)',
              background: 'var(--t-panel, var(--t-bg-card))',
              boxShadow: 'var(--t-shadow-card, 0 12px 32px rgba(15, 23, 42, 0.14))',
            }}>
              {repos.map((repo) => (
                <button
                  key={repo.localPath}
                  type="button"
                  onClick={() => { setRepoPath(repo.localPath); setRepoMenuOpen(false); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    paddingTop: 6,
                    paddingBottom: 6,
                    paddingLeft: 12,
                    paddingRight: 12,
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--t-text)',
                    fontSize: 12.5,
                    fontFamily: UI_FONT,
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ width: 12, display: 'inline-flex' }}>
                    {repo.localPath === repoPath ? <CheckGlyph /> : null}
                  </span>
                  {repo.name}
                </button>
              ))}
            </div>
          ) : null}

          <span style={{ width: 1, height: 16, background: 'var(--t-divider-subtle)', marginLeft: 2, marginRight: 2 }} />

          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => { setTab(item.id); setExpandedRow(null); }}
              aria-pressed={tab === item.id}
              style={{
                paddingTop: 4,
                paddingBottom: 4,
                paddingLeft: 10,
                paddingRight: 10,
                borderRadius: 8,
                border: 'none',
                background: tab === item.id ? 'var(--t-hover, var(--t-bg-card))' : 'transparent',
                color: tab === item.id ? 'var(--t-text)' : 'var(--t-text-muted)',
                fontSize: 12,
                fontWeight: tab === item.id ? 460 : 400,
                fontFamily: UI_FONT,
                cursor: 'pointer',
                transition: 'background 120ms ease, color 120ms ease',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* Content — instant swap, no transitions (Cursor hybrid-motion rule) */}
        {loading ? (
          <div style={{ paddingTop: 32, fontSize: 12, color: 'var(--t-text-muted)' }}>Loading…</div>
        ) : tab === 'rules' ? (
          <RulesTab directives={directives.filter((d) => matches(d.title, d.body, d.repoName))} expandedRow={expandedRow} onToggleRow={setExpandedRow} />
        ) : tab === 'connections' ? (
          <ConnectionsTab servers={servers.filter((s) => matches(s.name, s.command, s.url))} query={q} expandedRow={expandedRow} onToggleRow={setExpandedRow} />
        ) : tab === 'commands' ? (
          <CommandsTab query={q} />
        ) : tab === 'agents' ? (
          <AgentsTab agents={agents.filter((a) => matches(a.name, a.description))} expandedRow={expandedRow} onToggleRow={setExpandedRow} />
        ) : (
          <HooksTab hooks={hooks.filter((h) => matches(h.event, h.command, h.matcher))} />
        )}
      </div>
    </div>
  );
}

// ── Shared list primitives ──

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, paddingTop: 14, paddingBottom: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--t-text)' }}>{label}</span>
      <span style={{ fontSize: 11.5, color: 'var(--t-text-faint)' }}>{count}</span>
    </div>
  );
}

function Row({ title, titleMono = false, subtitle, pill, expanded, onClick, children }: {
  title: string;
  titleMono?: boolean;
  subtitle?: string | null;
  pill?: string | null;
  expanded?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        {...(onClick
          ? {
              role: 'button',
              tabIndex: 0,
              onClick,
              onKeyDown: (event: React.KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onClick();
                }
              },
            }
          : {})}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 10,
          paddingRight: 10,
          borderRadius: 9,
          background: hover || expanded ? 'var(--t-hover, var(--t-bg-card))' : 'transparent',
          cursor: onClick ? 'pointer' : 'default',
          transition: 'background 100ms ease',
        }}
      >
        <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span style={{
            fontSize: 12.5,
            fontWeight: 460,
            color: 'var(--t-text)',
            fontFamily: titleMono ? MONO_FONT : UI_FONT,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {title}
          </span>
          {subtitle ? (
            <span style={{
              fontSize: 11.5,
              color: 'var(--t-text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {subtitle}
            </span>
          ) : null}
        </div>
        {pill ? (
          <span style={{
            flexShrink: 0,
            fontSize: 10,
            color: 'var(--t-text-muted)',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider)',
            borderRadius: 999,
            paddingTop: 1,
            paddingBottom: 1,
            paddingLeft: 7,
            paddingRight: 7,
          }}>
            {pill}
          </span>
        ) : null}
        {onClick ? <RowChevron open={expanded === true} /> : null}
      </div>
      {expanded && children ? (
        <div style={{
          marginLeft: 10,
          marginRight: 10,
          marginBottom: 6,
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 12,
          paddingRight: 12,
          borderRadius: 8,
          background: 'var(--t-bg-card, rgba(148, 163, 184, 0.06))',
        }}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({ title, body, actionLabel, onAction }: {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div style={{
      marginTop: 16,
      paddingTop: 28,
      paddingBottom: 28,
      paddingLeft: 24,
      paddingRight: 24,
      borderRadius: 12,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: 'var(--t-divider-subtle)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 6,
      textAlign: 'center',
    }}>
      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text)' }}>{title}</span>
      <span style={{ fontSize: 12, color: 'var(--t-text-muted)', maxWidth: 420, lineHeight: 1.5 }}>{body}</span>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          style={{
            marginTop: 8,
            paddingTop: 5,
            paddingBottom: 5,
            paddingLeft: 12,
            paddingRight: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider)',
            background: 'var(--t-input-bg)',
            color: 'var(--t-text)',
            fontSize: 12,
            fontFamily: UI_FONT,
            cursor: 'pointer',
          }}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

// ── Tabs ──

function RulesTab({ directives, expandedRow, onToggleRow }: {
  directives: DirectiveSummary[];
  expandedRow: string | null;
  onToggleRow: (id: string | null) => void;
}) {
  const global = directives.filter((d) => !d.repoName);
  const repoScoped = directives.filter((d) => d.repoName);
  if (directives.length === 0) {
    return (
      <EmptyState
        title="No rules yet"
        body="Rules are Cortex directives — durable guidance every orchestrator turn sees. They come from your o8.md, accepted auto-directive proposals, and the directives API."
      />
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {global.length > 0 ? (
        <>
          <SectionHeader label="Global" count={global.length} />
          {global.map((d) => (
            <Row
              key={d.id}
              title={d.title}
              subtitle={d.body.replace(/\s+/g, ' ').slice(0, 160)}
              pill={d.priority != null ? `P${d.priority}` : null}
              expanded={expandedRow === d.id}
              onClick={() => onToggleRow(expandedRow === d.id ? null : d.id)}
            >
              <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--t-text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {d.body}
              </div>
            </Row>
          ))}
        </>
      ) : null}
      {repoScoped.length > 0 ? (
        <>
          <SectionHeader label="Repo" count={repoScoped.length} />
          {repoScoped.map((d) => (
            <Row
              key={d.id}
              title={d.title}
              subtitle={`${d.repoName} — ${d.body.replace(/\s+/g, ' ').slice(0, 120)}`}
              pill={d.priority != null ? `P${d.priority}` : null}
              expanded={expandedRow === d.id}
              onClick={() => onToggleRow(expandedRow === d.id ? null : d.id)}
            >
              <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--t-text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {d.body}
              </div>
            </Row>
          ))}
        </>
      ) : null}
    </div>
  );
}

function ConnectionsTab({ servers, query, expandedRow, onToggleRow }: {
  servers: ExternalServer[];
  query: string;
  expandedRow: string | null;
  onToggleRow: (id: string | null) => void;
}) {
  const builtins = BUILTIN_CONNECTIONS.filter((b) => !query || b.name.includes(query) || b.detail.toLowerCase().includes(query));
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <SectionHeader label="o8 built-in" count={builtins.length} />
      {builtins.map((builtin) => (
        <Row key={builtin.name} title={builtin.name} titleMono subtitle={builtin.detail} pill="always on" />
      ))}

      <SectionHeader label="External MCP servers" count={servers.length} />
      {servers.length === 0 ? (
        <EmptyState
          title="No external MCP servers"
          body="Connect external MCP servers — every orchestrator turn and dispatched worker can use their tools. Managed in Settings."
          actionLabel="Add in Settings"
          onAction={openSettingsMcpTab}
        />
      ) : servers.map((server) => (
        <Row
          key={server.id}
          title={server.name}
          titleMono
          subtitle={server.transport === 'http' ? server.url ?? 'http' : server.command ?? 'stdio'}
          pill={server.enabled === false ? 'disabled' : server.transport}
          expanded={expandedRow === server.id}
          onClick={() => onToggleRow(expandedRow === server.id ? null : server.id)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <DetailLine label="Transport" value={server.transport} />
            {server.command ? <DetailLine label="Command" value={server.command} mono /> : null}
            {server.url ? <DetailLine label="URL" value={server.url} mono /> : null}
            <DetailLine label="Status" value={server.enabled === false ? 'Disabled' : 'Enabled'} />
            <button
              type="button"
              onClick={openSettingsMcpTab}
              style={{
                alignSelf: 'flex-start',
                marginTop: 2,
                border: 'none',
                background: 'transparent',
                padding: 0,
                fontSize: 12,
                color: 'var(--t-accent, #2563eb)',
                cursor: 'pointer',
                fontFamily: UI_FONT,
              }}
            >
              Open in Settings ›
            </button>
          </div>
        </Row>
      ))}
    </div>
  );
}

function DetailLine({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 8, minWidth: 0 }}>
      <span style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--t-text-faint)', width: 68, flexShrink: 0, paddingTop: 1 }}>
        {label}
      </span>
      <span style={{
        fontSize: 11.5,
        color: 'var(--t-text-secondary)',
        fontFamily: mono ? MONO_FONT : UI_FONT,
        wordBreak: 'break-all',
      }}>
        {value}
      </span>
    </div>
  );
}

function CommandsTab({ query }: { query: string }) {
  const groups = useMemo(() => {
    const byGroup = new Map<string, typeof ORCHESTRATOR_SLASH_COMMANDS>();
    for (const command of ORCHESTRATOR_SLASH_COMMANDS) {
      if (query && !command.command.toLowerCase().includes(query) && !command.description.toLowerCase().includes(query)) continue;
      const group = command.group ?? 'general';
      const list = byGroup.get(group) ?? [];
      list.push(command);
      byGroup.set(group, list);
    }
    return [...byGroup.entries()];
  }, [query]);

  if (groups.length === 0) {
    return <EmptyState title="No matching commands" body="Slash commands run from the orchestrator composer — type / to use them." />;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {groups.map(([group, commands]) => (
        <div key={group} style={{ display: 'flex', flexDirection: 'column' }}>
          <SectionHeader label={group} count={commands.length} />
          {commands.map((command) => (
            <Row
              key={command.command}
              title={command.command}
              titleMono
              subtitle={command.description}
              pill={command.argHint ?? null}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function AgentsTab({ agents, expandedRow, onToggleRow }: {
  agents: AgentEntry[];
  expandedRow: string | null;
  onToggleRow: (id: string | null) => void;
}) {
  const user = agents.filter((a) => a.scope === 'user');
  const project = agents.filter((a) => a.scope === 'project');
  if (agents.length === 0) {
    return (
      <EmptyState
        title="No agent definitions"
        body="Subagent definitions live in .claude/agents (repo) and ~/.claude/agents (user) — markdown files with a name, description, and system prompt."
      />
    );
  }
  const section = (label: string, list: AgentEntry[]) => (
    list.length > 0 ? (
      <>
        <SectionHeader label={label} count={list.length} />
        {list.map((agent) => (
          <Row
            key={agent.file}
            title={agent.name}
            titleMono
            subtitle={agent.description}
            expanded={expandedRow === agent.file}
            onClick={() => onToggleRow(expandedRow === agent.file ? null : agent.file)}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {agent.description ? (
                <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--t-text-secondary)' }}>{agent.description}</div>
              ) : null}
              <DetailLine label="File" value={agent.file} mono />
            </div>
          </Row>
        ))}
      </>
    ) : null
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {section('User', user)}
      {section('Repo', project)}
    </div>
  );
}

function HooksTab({ hooks }: { hooks: HookEntry[] }) {
  const user = hooks.filter((h) => h.scope === 'user');
  const project = hooks.filter((h) => h.scope === 'project');
  if (hooks.length === 0) {
    return (
      <EmptyState
        title="No hooks configured"
        body="Hooks run shell commands on agent lifecycle events (PreToolUse, PostToolUse, SessionStart) — configured in .claude/settings.json."
      />
    );
  }
  const section = (label: string, list: HookEntry[]) => (
    list.length > 0 ? (
      <>
        <SectionHeader label={label} count={list.length} />
        {list.map((hook, index) => (
          <div
            key={`${hook.scope}-${hook.event}-${index}`}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              paddingTop: 7,
              paddingBottom: 7,
              paddingLeft: 10,
              paddingRight: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 460, color: 'var(--t-text)', fontFamily: MONO_FONT }}>{hook.event}</span>
              {hook.matcher ? (
                <span style={{ fontSize: 10.5, color: 'var(--t-text-faint)', fontFamily: MONO_FONT }}>{hook.matcher}</span>
              ) : null}
            </div>
            <span style={{
              fontSize: 11,
              color: 'var(--t-text-muted)',
              fontFamily: MONO_FONT,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {hook.command}
            </span>
          </div>
        ))}
      </>
    ) : null
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {section('User', user)}
      {section('Repo', project)}
    </div>
  );
}

// ── Glyphs (raw SVG — no icon component libraries in the Tauri webview) ──

function SearchGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--t-text-faint)', flexShrink: 0 }}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function ChevronDownGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--t-text-faint)' }}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--t-text)' }}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function RowChevron({ open }: { open: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{
      flexShrink: 0,
      color: 'var(--t-text-faint)',
      transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
      transition: 'transform 120ms cubic-bezier(0.22, 1, 0.36, 1)',
    }}>
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

export default CustomizePage;
