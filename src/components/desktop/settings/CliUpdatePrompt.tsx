'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CliUpdateRecord } from '@/lib/setup/cli-updates';
import { SettingsGroup, SettingsRow, ValuePill } from './grouped';

type UpdateResponse = { tools?: CliUpdateRecord[]; checkedAt?: string; error?: string };

export function CliUpdatePrompt() {
  const [tools, setTools] = useState<CliUpdateRecord[]>([]);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async (refresh: boolean) => {
    setChecking(true);
    setError(null);
    try {
      const response = await fetch(`/api/setup/cli-updates${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
      const data = await response.json() as UpdateResponse;
      if (!response.ok || !Array.isArray(data.tools)) throw new Error(data.error ?? 'Could not check CLI versions.');
      setTools(data.tools);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not check CLI versions.');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void check(false); }, [check]);

  const installed = tools.filter((tool) => tool.status !== 'not-installed');
  const outdated = installed.filter((tool) => tool.status === 'update-available');
  const summary = checking
    ? 'Checking the CLI versions o8 will launch…'
    : error
      ? error
      : installed.length === 0
        ? 'No supported CLI installation was found for this update check.'
      : outdated.length > 0
        ? `${outdated.length} CLI update${outdated.length === 1 ? '' : 's'} available. Update the selected installation before using newer models or features.`
        : installed.some((tool) => tool.status === 'unknown')
          ? 'Some release versions could not be checked. Your installed CLIs can still run.'
          : 'Installed CLIs match the latest stable releases checked.';

  return (
    <section style={{ marginTop: 28 }}>
      <SettingsGroup header="CLI updates" footnote="Checks each selected CLI against its own stable release. Antigravity (agy) and Gemini CLI (gemini) update separately. This does not install or replace tools while agents are running.">
        <SettingsRow
          label="Check runtime versions"
          subtitle={summary}
          value={checking ? 'Checking…' : 'Check again'}
          onPress={() => { void check(true); }}
          disabled={checking}
          divider={installed.length > 0}
        />
        {installed.map((tool, index) => (
          <SettingsRow
            key={tool.runtimeId}
            label={tool.label}
            subtitle={tool.status === 'update-available'
              ? `Installed ${tool.installedVersion ?? 'unknown'} · latest ${tool.latestVersion ?? 'unknown'}. Open the official ${tool.runtimeId === 'antigravity' ? 'Antigravity CLI' : tool.label} setup page for this binary.`
              : tool.status === 'current'
                ? `Installed ${tool.installedVersion} · latest ${tool.latestVersion}`
                : `Installed version ${tool.installedVersion ?? 'unknown'} · latest release could not be verified.`}
            accessory={<ValuePill tone={tool.status === 'current' ? 'success' : 'default'}>{tool.status === 'update-available' ? 'Update' : tool.status === 'current' ? 'Current' : 'Unverified'}</ValuePill>}
            onPress={tool.status === 'update-available'
              ? () => window.open(tool.updateUrl, '_blank', 'noopener,noreferrer')
              : undefined}
            chevron={tool.status === 'update-available'}
            divider={index < installed.length - 1}
          />
        ))}
      </SettingsGroup>
    </section>
  );
}
