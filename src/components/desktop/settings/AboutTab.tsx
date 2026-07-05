'use client';

import packageJson from '../../../../package.json';
import { toast } from '@/components/shared/ConfirmToastHost';
import {
  APP_FONT_STACK,
  RAMS_INK_QUIET,
  TabBreadcrumb,
  TabHeading,
  normalizeVersion,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { SettingsGroup, SettingsRow } from './grouped';
import { ReportIssueSection } from './ReportIssueSection';

export function AboutTab() {
  const isProduction = process.env.NODE_ENV === 'production';
  const platform = (() => {
    if (typeof navigator !== 'undefined' && navigator.platform) return navigator.platform;
    return '—';
  })();

  const nowIso = (() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  })();

  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 32,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabBreadcrumb tab="about" />
      <TabHeading
        title="about"
        subtitle="A precision instrument for autonomous engineering teams. Built with Next.js and Tauri."
      />

      <section>
        <SettingsGroup header="Version">
          <SettingsRow label="Version" value={normalizeVersion(packageJson.version)} divider />
          <SettingsRow label="Platform" value={platform} divider />
          <SettingsRow label="Mode" value={isProduction ? 'Production' : 'Development'} divider />
          <SettingsRow label="Updated" value={nowIso} />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup header="Links">
          <SettingsRow
            label="github"
            onPress={() => window.open('https://github.com/hurttlocker/o8', '_blank', 'noopener,noreferrer')}
            chevron
            divider
          />
          <SettingsRow
            label="docs"
            onPress={() => window.open('https://github.com/hurttlocker/o8/tree/main/docs', '_blank', 'noopener,noreferrer')}
            chevron
            divider
          />
          <SettingsRow
            label="releases"
            onPress={() => window.open('https://github.com/hurttlocker/o8/releases/latest', '_blank', 'noopener,noreferrer')}
            chevron
          />
        </SettingsGroup>
      </section>

      <ReportIssueSection number="03" />

      <section style={{ marginTop: 28 }}>
        <SettingsGroup header="Credits">
          <div style={{
            paddingTop: 14,
            paddingBottom: 14,
            paddingLeft: 14,
            paddingRight: 14,
            fontSize: 13,
            color: 'var(--t-text-secondary)',
            lineHeight: 1.6,
            maxWidth: 620,
          }}>
            o8 is built on Next.js 16, Tauri v2, and the runtime adapter system. It ships with the Codex, Claude Code, and Gemini adapters and the operator MCP server that lets Claude drive the webview. Design language is Dieter Rams × Swiss-Korean editorial — less, but better.
          </div>
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup header="Onboarding">
          <SettingsRow
            label="Replay onboarding"
            subtitle="Replay the welcome flow — the o8 intro, repos, runtimes, and the rest. Handy to revisit, or to walk a teammate through it."
            onPress={() => { window.dispatchEvent(new CustomEvent('o8-trigger-onboarding')); }}
            chevron
          />
        </SettingsGroup>
      </section>

      {/* Developer tools (dev only) */}
      {!isProduction ? (
        <section style={{ marginTop: 28 }}>
          <SettingsGroup header="Developer">
            <SettingsRow
              label="Reset + run onboarding"
              onPress={async () => {
                await fetch('/api/setup/config', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ setupComplete: false, completedAt: null }),
                });
                window.location.href = '/dashboard';
              }}
              chevron
              divider
            />
            <SettingsRow
              label="Preview onboarding"
              onPress={() => { window.dispatchEvent(new CustomEvent('o8-trigger-onboarding')); }}
              chevron
              divider
            />
            <SettingsRow
              label="View detection"
              subtitle="Logs the setup/detect result to the console"
              onPress={async () => {
                const res = await fetch('/api/setup/detect');
                const data = await res.json();
                console.log('[setup/detect]', data);
                toast('Detection result logged to the console.', 'info');
              }}
              chevron
            />
          </SettingsGroup>
        </section>
      ) : null}

      {/* Footer timestamp */}
      <div style={{
        marginTop: 32,
        fontFamily: APP_FONT_STACK,
        fontSize: 11,
        fontWeight: 400,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: RAMS_INK_QUIET,
      }}>
        {nowIso} · viewed
      </div>
    </div>
  );
}
