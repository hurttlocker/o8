'use client';

/**
 * MCPTab — Claude Desktop / Claude Code integration.
 *
 * Fetches /api/setup/mcp-config, shows the generated JSON snippet, and lets
 * the user copy it or (on macOS) write it directly into their Claude Desktop
 * config file.
 *
 * This closes the "how do I connect Claude to o8?" gap. Without this tab a
 * real user has no discoverable path from "installed o8" to "Claude sees
 * the o8 tools."
 */

import { useCallback, useEffect, useState } from 'react';
import { APP_FONT_STACK } from './shared';
import { ClaudeIcon } from '../repo-registry/shared';
import { ChevronDown, ChevronRight } from '../lucide-shims';

interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface McpConfigResponse {
  server: McpServerConfig;
  fullConfig: { mcpServers: Record<string, McpServerConfig> };
  instructions: { claudeDesktop: string; claudeCode: string };
  diagnostics: {
    apiBase: string;
    apiPort?: number;
    wsPort?: number;
    portSource?: 'env' | 'file' | 'default';
    bundled: boolean;
    platform: string;
    nodeInstalled: boolean;
    nodeBin: string | null;
    codexInstalled: boolean;
    codexBin: string | null;
    ghInstalled: boolean;
    ghBin: string | null;
    dataDir: string;
    dbExists: boolean;
    dbSize: number;
  };
}

type Target = 'claude-desktop' | 'claude-code';

interface ClaudeTargetStatus {
  target: Target;
  path: string;
  fileExists: boolean;
  alreadyRegistered: boolean;
  alreadyUpToDate: boolean;
  otherServers: string[];
  size: number;
}

const MONO_FONT = '"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontSize: 15,
        fontWeight: 600,
        color: 'var(--t-text)',
        letterSpacing: '-0.01em',
      }}>
        {title}
      </div>
      {subtitle ? (
        <div style={{
          fontSize: 12,
          color: 'var(--t-text-muted)',
          marginTop: 4,
          lineHeight: 1.5,
        }}>
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}

function StatusRow({ label, ok, detail }: { label: string; ok: boolean; detail?: string | null }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 12,
      padding: '6px 0',
    }}>
      <span style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: ok ? '#22c55e' : '#ef4444',
        flexShrink: 0,
      }} />
      <span style={{ color: 'var(--t-text)', fontWeight: 500, minWidth: 120 }}>
        {label}
      </span>
      <span style={{
        color: 'var(--t-text-muted)',
        fontFamily: MONO_FONT,
        fontSize: 11,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {detail || (ok ? 'installed' : 'missing')}
      </span>
    </div>
  );
}

export function MCPTab() {
  const [data, setData] = useState<McpConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [desktopStatus, setDesktopStatus] = useState<ClaudeTargetStatus | null>(null);
  const [codeStatus, setCodeStatus] = useState<ClaudeTargetStatus | null>(null);
  const [installing, setInstalling] = useState<Target | null>(null);
  const [installNote, setInstallNote] = useState<{ target: Target; message: string; ok: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/setup/mcp-config');
      if (!res.ok) throw new Error(`${res.status}`);
      const json = await res.json() as McpConfigResponse;
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load MCP config');
    }
  }, []);

  const loadClaudeStatus = useCallback(async () => {
    try {
      const [desktop, code] = await Promise.all([
        fetch('/api/setup/claude-desktop?target=claude-desktop').then((r) => r.json() as Promise<ClaudeTargetStatus>),
        fetch('/api/setup/claude-desktop?target=claude-code').then((r) => r.json() as Promise<ClaudeTargetStatus>),
      ]);
      setDesktopStatus(desktop);
      setCodeStatus(code);
    } catch {
      // Silent — the status cards just don't render.
    }
  }, []);

  useEffect(() => { void load(); void loadClaudeStatus(); }, [load, loadClaudeStatus]);

  const installToClaude = useCallback(async (target: Target) => {
    setInstalling(target);
    setInstallNote(null);
    try {
      const res = await fetch('/api/setup/claude-desktop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      const body = await res.json() as { ok: boolean; detail?: string; error?: string };
      if (res.ok && body.ok) {
        setInstallNote({ target, message: body.detail || 'Installed.', ok: true });
        await loadClaudeStatus();
      } else {
        setInstallNote({ target, message: body.error || body.detail || 'Failed to install.', ok: false });
      }
    } catch (e) {
      setInstallNote({
        target,
        message: e instanceof Error ? e.message : 'Request failed.',
        ok: false,
      });
    } finally {
      setInstalling(null);
    }
  }, [loadClaudeStatus]);

  const removeFromClaude = useCallback(async (target: Target) => {
    setInstalling(target);
    setInstallNote(null);
    try {
      const res = await fetch('/api/setup/claude-desktop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, remove: true }),
      });
      const body = await res.json() as { ok: boolean; detail?: string; error?: string };
      if (res.ok && body.ok) {
        setInstallNote({ target, message: body.detail || 'Removed.', ok: true });
        await loadClaudeStatus();
      } else {
        setInstallNote({ target, message: body.error || body.detail || 'Failed.', ok: false });
      }
    } finally {
      setInstalling(null);
    }
  }, [loadClaudeStatus]);

  const copyToClipboard = useCallback(async () => {
    if (!data) return;
    const text = JSON.stringify(data.fullConfig, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for Tauri webview / environments without clipboard API
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [data]);

  if (error) {
    return (
      <div style={{ color: 'var(--t-text-muted)', fontSize: 13 }}>
        Failed to load MCP config: {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ color: 'var(--t-text-muted)', fontSize: 13 }}>
        Loading MCP config...
      </div>
    );
  }

  const configJson = JSON.stringify(data.fullConfig, null, 2);
  const d = data.diagnostics;
  const ready = d.nodeInstalled;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* ── Hero ── */}
      <div>
        <SectionHeader
          title="Connect Claude"
          subtitle="One click to let Claude Desktop or Claude Code dispatch work to your o8 fleet. Your other MCP servers stay untouched — we only write the o8 entry."
        />

        {!ready ? (
          <div style={{
            marginBottom: 14,
            padding: '14px 16px',
            borderRadius: 12,
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.22)',
            fontSize: 13,
            color: 'var(--t-text)',
            lineHeight: 1.55,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Install Node.js first</div>
            <div style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>
              o8&apos;s MCP server runs on Node. Grab the latest LTS from{' '}
              <a
                href="https://nodejs.org"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--t-accent)', textDecoration: 'underline' }}
              >
                nodejs.org
              </a>
              {' '}(v22+), then relaunch o8.
            </div>
          </div>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <ClaudeTargetCard
            label="Claude Desktop"
            target="claude-desktop"
            status={desktopStatus}
            installing={installing === 'claude-desktop'}
            disabled={!ready}
            note={installNote?.target === 'claude-desktop' ? installNote : null}
            onInstall={() => { void installToClaude('claude-desktop'); }}
            onRemove={() => { void removeFromClaude('claude-desktop'); }}
            restartHint="Quit Claude Desktop (⌘Q) and reopen it."
          />
          <ClaudeTargetCard
            label="Claude Code"
            target="claude-code"
            status={codeStatus}
            installing={installing === 'claude-code'}
            disabled={!ready}
            note={installNote?.target === 'claude-code' ? installNote : null}
            onInstall={() => { void installToClaude('claude-code'); }}
            onRemove={() => { void removeFromClaude('claude-code'); }}
            restartHint="Restart Claude Code or run /mcp reload."
          />
        </div>
      </div>

      {/* ── System details (collapsed) ── */}
      <Disclosure title="System details" subtitle="Show the runtime environment o8 is using.">
        <div style={{
          padding: 14,
          borderRadius: 12,
          background: 'var(--t-panel)',
          border: '1px solid var(--t-panel-border)',
        }}>
          <StatusRow
            label="Backend"
            ok={true}
            detail={`${d.apiBase}${d.portSource ? ` (${d.portSource === 'env' ? 'env var' : d.portSource === 'file' ? 'port file' : 'default'})` : ''}`}
          />
          <StatusRow label="Install mode" ok={true} detail={d.bundled ? 'Packaged Tauri app' : 'Dev checkout'} />
          <StatusRow label="Node.js" ok={d.nodeInstalled} detail={d.nodeBin} />
          <StatusRow label="Codex CLI" ok={d.codexInstalled} detail={d.codexBin} />
          <StatusRow label="GitHub CLI" ok={d.ghInstalled} detail={d.ghBin} />
          <StatusRow label="Database" ok={d.dbExists} detail={d.dbExists ? `${(d.dbSize / 1024 / 1024).toFixed(1)} MB` : 'not initialized'} />
        </div>
        {d.nodeInstalled && !d.codexInstalled ? (
          <div style={{
            marginTop: 10,
            padding: 12,
            borderRadius: 10,
            background: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid rgba(245, 158, 11, 0.28)',
            fontSize: 12,
            color: 'var(--t-text)',
            lineHeight: 1.55,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Codex CLI not found</div>
            <div style={{ color: 'var(--t-text-muted)' }}>
              Install with{' '}
              <code style={{ fontFamily: MONO_FONT, background: 'var(--t-input-bg)', padding: '1px 6px', borderRadius: 4, fontSize: 11 }}>
                npm i -g @openai/codex-cli
              </code>
              {' '}and sign in with ChatGPT Plus or an OPENAI_API_KEY. Without Codex, mission dispatch won&apos;t work — but o8_status, directives, and the desktop UI still do.
            </div>
          </div>
        ) : null}
        {d.nodeInstalled && d.codexInstalled && !d.ghInstalled ? (
          <div style={{
            marginTop: 10,
            padding: 12,
            borderRadius: 10,
            background: 'var(--t-bg-card, rgba(148, 163, 184, 0.08))',
            border: '1px solid var(--t-panel-border)',
            fontSize: 12,
            color: 'var(--t-text-muted)',
            lineHeight: 1.55,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--t-text)' }}>GitHub CLI not found (optional)</div>
            <div>
              Install with{' '}
              <code style={{ fontFamily: MONO_FONT, background: 'var(--t-input-bg)', padding: '1px 6px', borderRadius: 4, fontSize: 11 }}>
                brew install gh
              </code>
              {' '}to enable create_mission from GitHub issues.
            </div>
          </div>
        ) : null}
      </Disclosure>

      {/* ── Manual config (collapsed) ── */}
      <Disclosure title="Manual config" subtitle="Prefer to edit the file yourself? Copy the JSON here.">
        <div style={{
          position: 'relative',
          borderRadius: 12,
          border: '1px solid var(--t-panel-border)',
          background: 'var(--t-input-bg)',
          overflow: 'hidden',
        }}>
          <button
            type="button"
            onClick={() => { void copyToClipboard(); }}
            style={{
              position: 'absolute',
              top: 10,
              right: 10,
              padding: '5px 12px',
              borderRadius: 8,
              border: '1px solid var(--t-accent-border)',
              background: copied ? 'var(--t-accent)' : 'var(--t-accent-soft)',
              color: copied ? '#ffffff' : 'var(--t-accent)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: APP_FONT_STACK,
              letterSpacing: '-0.01em',
              transition: 'background 120ms ease, color 120ms ease',
              zIndex: 1,
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <pre style={{
            margin: 0,
            padding: 14,
            fontFamily: MONO_FONT,
            fontSize: 12,
            color: 'var(--t-text)',
            overflow: 'auto',
            maxHeight: 260,
            lineHeight: 1.55,
          }}>
            {configJson}
          </pre>
        </div>
      </Disclosure>
    </div>
  );
}

// ── Disclosure ──

function Disclosure({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '10px 2px',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: APP_FONT_STACK,
        }}
      >
        <span style={{ display: 'inline-flex', color: 'var(--t-text-muted)' }}>
          {open ? <ChevronDown size={14} strokeWidth={2.2} /> : <ChevronRight size={14} strokeWidth={2.2} />}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
          {title}
        </span>
        {subtitle ? (
          <span style={{ fontSize: 12, color: 'var(--t-text-muted)', marginLeft: 4 }}>
            {subtitle}
          </span>
        ) : null}
      </button>
      {open ? <div style={{ marginTop: 8 }}>{children}</div> : null}
    </div>
  );
}

// ── Claude target card ──

function ClaudeTargetCard({
  label,
  target: _target,
  status,
  installing,
  disabled = false,
  note,
  onInstall,
  onRemove,
  restartHint,
}: {
  label: string;
  target: Target;
  status: ClaudeTargetStatus | null;
  installing: boolean;
  disabled?: boolean;
  note: { target: Target; message: string; ok: boolean } | null;
  onInstall: () => void;
  onRemove: () => void;
  restartHint: string;
}) {
  const connected = Boolean(status?.alreadyUpToDate);
  const needsUpdate = Boolean(status?.alreadyRegistered && !status?.alreadyUpToDate);

  const statusLine = !status
    ? 'Checking…'
    : connected
      ? 'Connected to o8'
      : needsUpdate
        ? 'Older o8 entry found — click Update'
        : status.fileExists
          ? `Ready to connect${status.otherServers.length > 0 ? ` (${status.otherServers.length} other server${status.otherServers.length === 1 ? '' : 's'})` : ''}`
          : 'Not connected yet';

  const primary = connected
    ? { label: 'Connected', disabled: true }
    : needsUpdate
      ? { label: 'Update', disabled: false }
      : { label: 'Connect', disabled: false };

  const primaryDisabled = disabled || installing || primary.disabled;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '14px 16px',
      borderRadius: 14,
      background: 'var(--t-panel)',
      border: `1px solid ${connected ? 'rgba(34, 197, 94, 0.24)' : 'var(--t-panel-border)'}`,
      boxShadow: connected ? '0 0 0 1px rgba(34, 197, 94, 0.1) inset' : 'none',
      transition: 'border-color 180ms ease, box-shadow 180ms ease',
      opacity: disabled ? 0.55 : 1,
    }}>
      {/* Logo */}
      <div style={{
        width: 40,
        height: 40,
        borderRadius: 10,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--t-bg-card, rgba(148, 163, 184, 0.1))',
        flexShrink: 0,
      }}>
        <ClaudeIcon size={22} />
      </div>

      {/* Name + status */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
            {label}
          </span>
          {connected ? (
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 8px',
              borderRadius: 999,
              background: 'rgba(34, 197, 94, 0.14)',
              color: '#16a34a',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.02em',
              textTransform: 'uppercase',
            }}>
              Connected
            </span>
          ) : null}
        </div>
        <div style={{
          marginTop: 2,
          fontSize: 12,
          color: 'var(--t-text-muted)',
          lineHeight: 1.4,
        }}>
          {statusLine}
        </div>
        {note ? (
          <div style={{
            marginTop: 8,
            padding: '7px 10px',
            borderRadius: 8,
            fontSize: 11,
            lineHeight: 1.5,
            background: note.ok ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
            border: `1px solid ${note.ok ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`,
            color: note.ok ? '#16a34a' : '#ef4444',
          }}>
            {note.ok ? `${note.message} ${restartHint}` : note.message}
          </div>
        ) : null}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {status?.alreadyRegistered ? (
          <button
            type="button"
            onClick={onRemove}
            disabled={installing || disabled}
            style={{
              padding: '7px 12px',
              borderRadius: 9,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'transparent',
              color: 'var(--t-text-muted)',
              fontSize: 12,
              fontWeight: 500,
              cursor: installing || disabled ? 'default' : 'pointer',
              opacity: installing ? 0.6 : 1,
              fontFamily: APP_FONT_STACK,
              minHeight: 32,
            }}
          >
            Remove
          </button>
        ) : null}
        <button
          type="button"
          onClick={onInstall}
          disabled={primaryDisabled}
          style={{
            padding: '7px 14px',
            borderRadius: 9,
            border: connected
              ? '1px solid rgba(34, 197, 94, 0.32)'
              : '1px solid rgba(143, 180, 255, 0.36)',
            background: connected
              ? 'rgba(34, 197, 94, 0.14)'
              : primaryDisabled
                ? 'rgba(143, 180, 255, 0.1)'
                : 'rgba(143, 180, 255, 0.22)',
            color: connected ? '#16a34a' : 'var(--t-accent)',
            fontSize: 12,
            fontWeight: 700,
            cursor: primaryDisabled ? 'default' : 'pointer',
            opacity: installing ? 0.7 : 1,
            fontFamily: APP_FONT_STACK,
            minHeight: 32,
            letterSpacing: '-0.01em',
            boxShadow: !primaryDisabled && !connected ? '0 0 10px rgba(143, 180, 255, 0.24)' : 'none',
            transition: 'background 140ms ease, box-shadow 140ms ease',
          }}
        >
          {installing ? 'Working…' : primary.label}
        </button>
      </div>
    </div>
  );
}
