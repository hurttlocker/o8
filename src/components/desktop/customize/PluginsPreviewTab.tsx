'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { RamsButton } from '../settings/shared';

type Page = 'installed' | 'browse' | 'detail' | 'install' | 'setup' | 'update' | 'contents' | 'sources';
type Contribution = 'skill' | 'command' | 'connection';
const initialPackage = { installed: true, enabled: true, connected: false, version: '1.0', updateFailed: false };
const actions: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' };
const section: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 };
const heading: CSSProperties = { marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, fontSize: 18, fontWeight: 400, color: 'var(--t-text)', lineHeight: 1.4 };
const paragraph: CSSProperties = { marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-text-muted)', fontSize: 13, lineHeight: 1.6 };
const surface: CSSProperties = {
  border: '1px solid var(--t-divider)', borderRadius: 12, background: 'var(--t-bg-card)',
  paddingTop: 20, paddingBottom: 20, paddingLeft: 20, paddingRight: 20,
};

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return <div role="status" style={{ ...surface, display: 'flex', flexDirection: 'column', gap: 8 }}>
    <strong style={{ color: 'var(--t-text)', fontSize: 13, fontWeight: 500 }}>{title}</strong>
    <div style={paragraph}>{children}</div>
  </div>;
}

function PreviewRow({ title, description, status, onClick }: { title: string; description: string; status: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} style={{
    display: 'flex', alignItems: 'center', gap: 16, width: '100%', minHeight: 88, border: 0, borderRadius: 10, background: 'transparent', paddingTop: 16, paddingRight: 12, paddingBottom: 16, paddingLeft: 12,
    textAlign: 'left', fontFamily: 'inherit', cursor: 'pointer', color: 'var(--t-text)',
  }}>
    <svg aria-hidden="true" width="38" height="38" viewBox="0 0 36 36" style={{ flexShrink: 0, borderRadius: 9, background: 'var(--t-hover)', color: 'var(--t-accent)' }} fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="9" y="9" width="18" height="18" rx="5" /><path d="M13 18h10M18 13v10" /></svg>
    <span style={{ flex: '1 1 220px', minWidth: 0 }}>
      <span style={{ display: 'block', fontSize: 14, fontWeight: 300, lineHeight: 1.4 }}>{title}</span>
      <span style={{ display: 'block', ...paragraph, marginTop: 6, fontSize: 12 }}>{description}</span>
    </span>
    <span style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>{status}</span>
  </button>;
}

/** Sample state stays in this component. Never install, authenticate, or persist from this preview. */
export default function PluginsPreviewTab() {
  const [page, setPage] = useState<Page>('installed');
  const [query, setQuery] = useState('');
  const [sample, setSample] = useState(initialPackage);
  const [keepSetup, setKeepSetup] = useState(true);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [message, setMessage] = useState('');
  const [contribution, setContribution] = useState<Contribution>('skill');
  const status = !sample.installed ? 'Not installed' : !sample.enabled ? 'Disabled' : !sample.connected ? 'Setup needed' : 'Ready';
  const go = (next: Page) => { setPage(next); setMessage(''); setConfirmRemove(false); };
  const viewContribution = (kind: Contribution) => { setContribution(kind); go('contents'); };
  const back = (next: Page = 'detail') => <div><RamsButton variant="ghost" onClick={() => go(next)}>{next === 'detail' ? 'Back to plugin' : next === 'browse' ? 'Back to Browse' : 'Back to Installed'}</RamsButton></div>;

  return <section aria-label="Plugin design preview" style={section}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', justifyContent: 'space-between' }}>
      <div style={{ flex: '1 1 240px' }}>
        <div style={{ fontSize: 13, color: 'var(--t-text)', marginBottom: 6 }}>Development preview</div>
        <p style={paragraph}>Sample catalog. Installation and account connection are not active.</p>
      </div>
      <RamsButton variant="ghost" onClick={() => { setSample(initialPackage); setKeepSetup(true); go('installed'); }}>Reset preview</RamsButton>
    </div>
    {message ? <Notice title="Preview updated">{message}</Notice> : null}
    {page === 'installed' || page === 'browse' ? <>
      <input aria-label="Search plugins" placeholder="Search plugins" value={query} onChange={(event) => setQuery(event.target.value)} style={{ width: '100%', boxSizing: 'border-box', minHeight: 42, borderRadius: 12, border: '1px solid var(--t-divider)', background: 'var(--t-input-bg)', color: 'var(--t-text)', paddingLeft: 16, paddingRight: 16, font: 'inherit' }} />
      <div style={actions} aria-label="Plugin views">
        <RamsButton variant={page === 'installed' ? 'primary' : 'ghost'} onClick={() => go('installed')}>Installed</RamsButton>
        <RamsButton variant={page === 'browse' ? 'primary' : 'ghost'} onClick={() => go('browse')}>Browse</RamsButton>
      </div>
      <h2 style={heading}>{page === 'installed' ? 'Installed · preview' : 'Marketplace · preview'}</h2>
      {(page === 'browse' || sample.installed) && 'project guide'.includes(query.toLowerCase()) ? <PreviewRow title="Project guide" description="A project skill, a command, and a documentation connection." status={sample.updateFailed ? `Update failed · ${status}` : status} onClick={() => go('detail')} />
        : <div style={surface}><h3 style={heading}>{query ? 'No matching plugins' : 'No sample plugins installed'}</h3><p style={{ ...paragraph, marginTop: 8 }}>Browse to add the example package again, or clear your search.</p></div>}
      {page === 'browse' ? <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 24 }}>
          {[['Google Drive', 'Bring project briefs and documents into your workspace.'], ['Slack', 'Connect project discussions and team context.']].filter(([name]) => name.toLowerCase().includes(query.toLowerCase())).map(([name, description]) => <PreviewRow key={name} title={name} description={description} status="Planned" onClick={() => setMessage(`${name} is a planned integration. Account connection and installation are not available yet.`)} />)}
        </div>
        {'device tools'.includes(query.toLowerCase()) ? <PreviewRow title="Device tools" description="Example of a package requiring a newer adapter." status="Not compatible" onClick={() => setMessage('Device tools requires a newer adapter. Installation is unavailable in this example.')} /> : null}
        <div><RamsButton variant="ghost" onClick={() => go('sources')}>Manage sources</RamsButton></div>
      </> : null}
    </> : null}

    {page === 'detail' ? <>
      {back('installed')}
      <div style={{ ...actions, justifyContent: 'space-between' }}><h2 style={heading}>Project guide <span style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>v{sample.installed ? sample.version : '1.1'}</span></h2><span style={paragraph}>{status}</span></div>
      <p style={paragraph}>Keep project conventions and documentation close to your agents.</p>
      {sample.updateFailed ? <Notice title="Update could not be activated">Version 1.0 remains available with its saved setup. Retry when you are ready.</Notice> : null}
      {sample.installed && sample.enabled && !sample.connected ? <Notice title="One setup step remaining">The skill and command can be available before the documentation connection is configured.</Notice> : null}
      <div style={actions}>
        {!sample.installed ? <RamsButton onClick={() => go('install')}>Review installation</RamsButton>
          : !sample.enabled ? <RamsButton onClick={() => { setSample((current) => ({ ...current, enabled: true })); setMessage(''); }}>Enable sample</RamsButton>
          : !sample.connected ? <RamsButton onClick={() => go('setup')}>Finish setup</RamsButton>
          : <RamsButton onClick={() => viewContribution('skill')}>Open included skill</RamsButton>}
        {sample.installed && sample.enabled ? <RamsButton variant="ghost" onClick={() => { setSample((current) => ({ ...current, enabled: false })); setMessage('Sample contributions are disabled. Saved setup is retained.'); }}>Disable sample</RamsButton> : null}
        {sample.installed && sample.version === '1.0' ? <RamsButton variant="ghost" onClick={() => go('update')}>{sample.updateFailed ? 'Retry update' : 'Update to 1.1'}</RamsButton> : null}
        {sample.installed ? <RamsButton variant="danger" onClick={() => setConfirmRemove(true)}>Remove sample</RamsButton> : null}
      </div>
      {confirmRemove ? <div style={{ ...surface, ...section }} aria-label="Confirm plugin removal">
        <h2 style={heading}>Remove Project guide?</h2><p style={paragraph}>Removes the sample package and its contributions. Independently added items stay in place.</p>
        <label style={{ ...actions, color: 'var(--t-text)', fontSize: 13, minHeight: 44 }}><input type="checkbox" checked={keepSetup} onChange={(event) => setKeepSetup(event.target.checked)} />Keep saved demo setup for reinstalling</label>
        <div style={actions}><RamsButton variant="danger" onClick={() => { setSample((current) => ({ ...current, installed: false, enabled: false, updateFailed: false, connected: keepSetup && current.connected })); go('installed'); setMessage(keepSetup ? 'Sample removed. Demo setup retained for reinstalling.' : 'Sample and its demo setup removed.'); }}>Confirm removal</RamsButton><RamsButton variant="ghost" onClick={() => setConfirmRemove(false)}>Cancel</RamsButton></div>
      </div> : null}
      <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: 20, marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0 }}>
        {[['Publisher', 'Example publisher'], ['Source', 'Demo catalog'], ['Availability', 'Personal workspace'], ['Package type', 'Skill, command, and connection definition']].map(([label, value]) => <div key={label}><dt style={{ ...paragraph, fontSize: 12 }}>{label}</dt><dd style={{ marginTop: 6, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-text)', fontSize: 13 }}>{value}</dd></div>)}
      </dl>
      <h3 style={heading}>Included in this package</h3>
      <PreviewRow title="Project conventions" description="Reusable project guidance" status="Skill" onClick={() => viewContribution('skill')} />
      <PreviewRow title="/project-guide" description="Review the project guidance before starting" status="Command" onClick={() => viewContribution('command')} />
      <PreviewRow title="Project documentation" description="Search a documentation collection" status="Connection" onClick={() => viewContribution('connection')} />
      <details><summary style={{ color: 'var(--t-text)', fontSize: 13, cursor: 'pointer' }}>Execution and access</summary><p style={{ ...paragraph, marginTop: 12 }}>This proposed package supplies instructions and a connection definition, with no install script or startup hook. The connection would send search queries to its configured documentation service when used. Availability is not a filesystem permission boundary.</p></details>
    </> : null}

    {page === 'install' ? <>
      {back()}<h2 style={heading}>Add Project guide</h2><p style={paragraph}>Version 1.1 includes one skill, one command, and one connection definition. Set up the connection separately. This example has no automatic hooks or install scripts.</p>
      <div style={actions}><RamsButton onClick={() => { setSample((current) => ({ ...current, installed: true, enabled: true, version: '1.1', updateFailed: false })); go('detail'); }}>Add to preview</RamsButton><RamsButton variant="ghost" onClick={() => go('detail')}>Cancel</RamsButton></div>
    </> : null}
    {page === 'setup' ? <>
      {back()}<h2 style={heading}>Set up Project documentation</h2><p style={paragraph}>In the implementation, Connections will own this setup. A plugin links to the same connection instead of asking for credentials again.</p>
      <div style={surface}><p style={paragraph}>Service: example documentation collection<br />Use: search on request<br />Data sent: the search query</p></div>
      <div style={actions}><RamsButton onClick={() => { setSample((current) => ({ ...current, connected: true })); go('detail'); }}>Use demo connection</RamsButton><RamsButton variant="ghost" onClick={() => go('detail')}>Not now</RamsButton></div>
    </> : null}
    {page === 'update' ? <>
      {back()}<h2 style={heading}>Update Project guide</h2><p style={paragraph}>Version 1.0 → 1.1 improves the sample instructions. No new connection, automatic hook, or access requirement.</p>
      <div style={actions}><RamsButton onClick={() => { setSample((current) => ({ ...current, version: '1.1', updateFailed: false })); go('detail'); }}>Apply demo update</RamsButton><RamsButton variant="ghost" onClick={() => go('detail')}>Cancel</RamsButton></div>
      <div style={{ ...surface, ...section }}><p style={paragraph}>Design review scenario: an update fails while the current version stays available.</p><div><RamsButton variant="ghost" onClick={() => { setSample((current) => ({ ...current, updateFailed: true })); go('detail'); }}>Simulate failed update</RamsButton></div></div>
    </> : null}
    {page === 'contents' ? <>
      {back()}<h2 style={heading}>Included {contribution}</h2><p style={paragraph}>Owned by Project guide. These sample entries are not mixed into your real Customize inventory.</p>
      {!sample.installed ? <Notice title="Package not installed">Add the example package to make its sample contributions available.</Notice> : <>
        <Notice title={!sample.enabled ? 'Plugin disabled' : contribution === 'connection' ? (sample.connected ? 'Demo connection ready' : 'Setup needed') : 'Sample contribution available'}>
          {contribution === 'skill' ? 'Use existing project patterns. Verify changes. Report unresolved questions.' : contribution === 'command' ? '/project-guide: review the project conventions before starting a task.' : 'Search the selected documentation collection on request.'}
        </Notice>
        {contribution === 'connection' && sample.enabled ? <div><RamsButton onClick={() => go('setup')}>{sample.connected ? 'View demo setup' : 'Finish setup'}</RamsButton></div> : null}
      </>}
    </> : null}
    {page === 'sources' ? <>
      {back('browse')}<h2 style={heading}>Marketplace sources</h2><PreviewRow title="Demo catalog" description="Fictional source used for this design preview." status="Sample" onClick={() => go('browse')} /><p style={paragraph}>Adding a source will provide listings, not install packages. Removing a source should preserve its installed packages. Source fetching and installation are not implemented here.</p>
    </> : null}
  </section>;
}
