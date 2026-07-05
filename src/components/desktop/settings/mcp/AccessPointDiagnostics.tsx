import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
} from '../shared';

export interface CliAccessStatus {
  installedAt: string | null;
  installStatus: string | null;
  onPath: boolean;
  nodeResolvable: boolean;
  nodeBin: string | null;
}

export interface AccessPointDiagnosticsData {
  apiBase: string;
  portSource?: 'env' | 'file' | 'default';
  bundled: boolean;
  nodeInstalled: boolean;
  nodeBin: string | null;
  codexInstalled: boolean;
  codexBin: string | null;
  ghInstalled: boolean;
  ghBin: string | null;
  dbExists: boolean;
  dbSize: number;
  webviewSocketPath: string;
  webviewToolsAvailable: boolean;
  cli: CliAccessStatus;
}

export function AccessPointDiagnostics({ diagnostics }: { diagnostics: AccessPointDiagnosticsData }) {
  const d = diagnostics;
  return (
    <div style={{
      paddingTop: 8,
      borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`,
    }}>
      <DiagnosticRow label="Backend" ok detail={`${d.apiBase}${d.portSource ? ` (${d.portSource === 'env' ? 'env var' : d.portSource === 'file' ? 'port file' : 'default'})` : ''}`} />
      <DiagnosticRow label="Install mode" ok detail={d.bundled ? 'Packaged Tauri app' : 'Dev checkout'} />
      <DiagnosticRow label="CLI installed" ok={Boolean(d.cli.installedAt)} detail={d.cli.installedAt ?? d.cli.installStatus ?? 'missing'} />
      <DiagnosticRow label="CLI on PATH" ok={d.cli.onPath} detail={d.cli.onPath ? 'available as o8' : 'run o8 doctor --repair, then add the install directory to PATH'} />
      <DiagnosticRow label="CLI Node" ok={d.cli.nodeResolvable} detail={d.cli.nodeBin ?? 'Node.js 22+ not resolvable'} />
      <DiagnosticRow label="Node.js" ok={d.nodeInstalled || d.cli.nodeResolvable} detail={d.nodeBin ?? d.cli.nodeBin} />
      <DiagnosticRow label="Codex CLI" ok={d.codexInstalled} detail={d.codexBin} />
      <DiagnosticRow label="GitHub CLI" ok={d.ghInstalled} detail={d.ghBin} />
      <DiagnosticRow label="Database" ok={d.dbExists} detail={d.dbExists ? `${(d.dbSize / 1024 / 1024).toFixed(1)} MB` : 'not initialized'} />
      <DiagnosticRow
        label="Webview tools"
        ok={d.webviewToolsAvailable}
        detail={d.webviewToolsAvailable
          ? `Connected to ${d.webviewSocketPath}`
          : 'Off - launch with --features dev-mcp-plugin'}
      />
    </div>
  );
}

function DiagnosticRow({ label, ok, detail }: { label: string; ok: boolean; detail?: string | null }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      paddingTop: 10,
      paddingBottom: 10,
      borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
    }}>
      <span style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        background: ok ? '#22c55e' : '#ef4444',
        flexShrink: 0,
      }} />
      <span style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 11,
        fontWeight: 400,
        color: RAMS_INK_QUIET,
        textTransform: 'uppercase',
        letterSpacing: '0.14em',
        minWidth: 130,
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: MONO_FONT_STACK,
        fontSize: 12,
        color: 'var(--t-text-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: 1,
      }}>
        {detail || (ok ? 'installed' : 'missing')}
      </span>
    </div>
  );
}
