'use client';

import { useEffect } from 'react';
import { refreshCliUpdateView, synchronizeConnectedClis, useUpdateHub } from '@/lib/app-update/update-hub-client';
import { ConnectedCliUpdateRows } from '../shell/ConnectedCliUpdateRows';
import { SettingsGroup, SettingsRow } from './grouped';

/** The same explicit tool action and live progress used by the update panel. */
export function CliUpdatePrompt() {
  const hub = useUpdateHub();
  useEffect(() => { void refreshCliUpdateView(); }, []);
  const installed = hub.tools.filter(tool => tool.status !== 'not-installed');
  return <section style={{ marginTop: 28 }}>
    <SettingsGroup header="Tools" footnote="o8 updates separately. Choose each CLI explicitly; updates keep the selected installation and wait for its running sessions.">
      <SettingsRow label="Check tool versions" subtitle={hub.checking ? 'Checking the versions o8 will launch…' : hub.cliError ?? 'Check installed tools against their own release channels.'}
        value={hub.checking ? 'Checking…' : 'Check again'} onPress={() => { void refreshCliUpdateView(true); }} disabled={hub.checking || hub.syncing} divider={installed.length > 0} />
      {installed.length ? <div style={{ paddingTop: 16, paddingRight: 18, paddingBottom: 16, paddingLeft: 18 }}>
        <ConnectedCliUpdateRows tools={installed} busy={hub.cliBusy} progress={hub.cliProgress} checking={hub.checking} disabled={hub.syncing || hub.app.installing}
          onUpdate={runtime => { void synchronizeConnectedClis(runtime).catch(() => {}); }} />
      </div> : null}
      {hub.cliMessage ? <div role="status" style={{ paddingRight: 18, paddingBottom: 12, paddingLeft: 18, fontSize: 11, color: 'var(--t-text-muted)' }}>{hub.cliMessage}</div> : null}
    </SettingsGroup>
  </section>;
}
