'use client';

import { useEffect, useState } from 'react';
import { MAX_PACKAGE_BYTES, packageSchema, type DamagedPackage, type InstalledPackage, type InstructionPackage } from '@/lib/customize/packages';
import { RamsButton } from '../settings/shared';
import { customizationCopy as copy, customizationField as field, SaveScope } from './AddSkillForm';
import { SkillCatalogItem } from './SkillCatalogItem';
import type { CustomizeRepo } from './inventory';
import type { SkillInventoryEntry } from './SkillsInventoryTab';

export default function PluginsTab({ repos, onChanged, onUseSkill, selectedRepo, onSelectRepo }: {
  selectedRepo: string; onSelectRepo: (repo: string) => void; repos: CustomizeRepo[]; onChanged: () => void; onUseSkill: (skill: SkillInventoryEntry) => void | Promise<void>;
}) {
  const repo = selectedRepo;
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<InstructionPackage[]>([]);
  const [damaged, setDamaged] = useState<DamagedPackage[]>([]);
  const [removeDamaged, setRemoveDamaged] = useState<string | null>(null);
  const [installed, setInstalled] = useState<InstalledPackage[]>([]);
  const [selected, setSelected] = useState<InstructionPackage | null>(null);
  const [review, setReview] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/customize/plugins${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`, { signal: controller.signal })
      .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? 'Could not load plugins.'); return data; })
      .then((data) => { if (!controller.signal.aborted) { setInstalled(data.installed); setDamaged(data.damaged ?? []); setCatalog(data.catalog); setLoading(false); } })
      .catch((error) => { if (!controller.signal.aborted) { setError(error.message); setLoading(false); } });
    return () => controller.abort();
  }, [repo, refresh]);
  const current = installed.find((entry) => entry.manifest.id === selected?.id);
  const pendingUpdate = Boolean(current && selected && current.manifest.version !== selected.version);
  const mutate = async (body: object, success: string) => {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/customize/plugins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: repo || null, ...body }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? 'Could not change this plugin.');
      setSelected(null); setReview(false); setConfirmRemove(false); setRemoveDamaged(null); setMessage(data.cleanupPending ? `${success} Some cached files could not be deleted.` : success); setLoading(true); setRefresh((value) => value + 1); onChanged();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not change this plugin.'); }
    finally { setBusy(false); }
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    setBusy(true); setError(''); setMessage('');
    try {
      if (file.size > MAX_PACKAGE_BYTES) throw new Error('Choose a bundle smaller than 512 KB.');
      const parsed = packageSchema.safeParse(JSON.parse(await file.text()));
      if (!parsed.success) throw new Error('This file is not an o8 instruction bundle. Only skills are supported; executable plugins and service connections cannot be imported.');
      const existing = installed.find((entry) => entry.manifest.id === parsed.data.id);
      if (existing?.manifest.version === parsed.data.version) throw new Error('This version is already installed. Import a newer version to update it.');
      setSelected(parsed.data); setReview(true); setConfirmRemove(false);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not import this bundle.'); }
    finally { setBusy(false); }
  };
  const choose = (manifest: InstructionPackage) => { setSelected(manifest); setReview(false); setConfirmRemove(false); setError(''); setMessage(''); };
  const matches = (entry: InstructionPackage) => `${entry.name} ${entry.description}`.toLowerCase().includes(query.toLowerCase());
  const actions = { display: 'flex', gap: 12, flexWrap: 'wrap' as const, alignItems: 'center' };
  return <section aria-label="Plugins" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
    <p style={copy}>Plugins bundle reusable skills. Installed skills appear in Skills and can be added to a task. These bundles do not install a service connection or run code on installation.</p>
    <div style={{ ...actions, alignItems: 'end' }}>
      <div style={{ flex: '1 1 220px' }}><SaveScope label="Plugin library" repos={repos} value={repo} disabled={busy} onChange={(value) => { onSelectRepo(value); setSelected(null); setRemoveDamaged(null); setLoading(true); setError(''); setMessage(''); }} /></div>
      <label style={{ color: 'var(--t-accent)', fontSize: 13 }}>Import bundle (.json)<input aria-label="Import plugin bundle" type="file" accept=".json,application/json" disabled={busy || loading} onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ''; }} style={{ display: 'block', marginTop: 8, maxWidth: '100%' }} /></label>
    </div>
    {error ? <div role="alert" style={copy}>{error} <RamsButton variant="ghost" disabled={busy} onClick={() => { setError(''); setLoading(true); setRefresh((value) => value + 1); }}>Refresh</RamsButton></div> : null}
    {message ? <p role="status" style={copy}>{message}</p> : null}
    {loading ? <p style={copy}>Loading plugins…</p> : selected ? <>
      <div><RamsButton variant="ghost" disabled={busy} onClick={() => { setSelected(null); setReview(false); setConfirmRemove(false); }}>All plugins</RamsButton></div>
      <div style={{ ...actions, justifyContent: 'space-between' }}><h2 style={{ margin: 0, fontSize: 22, fontWeight: 400, color: 'var(--t-text)' }}>{selected.name}</h2><span style={copy}>Version {selected.version}</span></div>
      <p style={copy}>{selected.description}</p>
      <p style={copy}>{review ? `Review ${pendingUpdate ? `update from ${current?.manifest.version} to ${selected.version}` : 'installation'}. ` : ''}{selected.skills.length} skills · {repo ? repos.find((entry) => entry.localPath === repo)?.name : 'Personal'} · {current ? current.enabled ? 'Enabled' : 'Disabled' : 'Not installed'}</p>
      {review ? <p style={copy}>Read the instructions below before installing. Imported bundles are local files, not verified publishers. Skills may guide an agent to use its existing tools and permissions when you invoke them.</p> : null}
      <div style={actions}>
        {!current || pendingUpdate ? <RamsButton variant="primary" busy={busy} onClick={() => review ? void mutate({ action: 'install', manifest: selected, expectedRevision: current?.revision ?? null }, `${selected.name} ${current ? 'updated' : 'installed'}. Its skills are available in Skills.`) : setReview(true)}>{review ? pendingUpdate ? 'Install update' : 'Install plugin' : 'Review installation'}</RamsButton> : <>
          <RamsButton variant="ghost" busy={busy} onClick={() => void mutate({ action: current.enabled ? 'disable' : 'enable', id: selected.id, revision: current.revision }, `${selected.name} ${current.enabled ? 'disabled' : 'enabled'}.`)}>{current.enabled ? 'Disable plugin' : 'Enable plugin'}</RamsButton>
          <RamsButton variant="danger" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove plugin</RamsButton>
        </>}
      </div>
      {confirmRemove && current ? <div style={{ border: '1px solid var(--t-divider)', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}><p style={copy}>Remove {selected.name} and its stored versions from this scope? Separately added skills stay in place. Instructions already used in a task are not withdrawn.</p><div style={actions}><RamsButton variant="danger" busy={busy} onClick={() => void mutate({ action: 'remove', id: selected.id, revision: current.revision }, `${selected.name} removed.`)}>Confirm removal</RamsButton><RamsButton variant="ghost" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</RamsButton></div></div> : null}
      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 400, color: 'var(--t-text)' }}>Included skills</h3>
      {selected.skills.map((skill) => <details key={skill.name} open={review} style={{ borderBottom: '1px solid var(--t-divider)', paddingBottom: 16 }}><summary style={{ color: 'var(--t-text)', fontSize: 14, cursor: 'pointer' }}>{skill.name} <span style={copy}>· {skill.description}</span></summary><p style={{ ...copy, marginTop: 16, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{skill.instructions}</p>{current?.enabled && !pendingUpdate ? <div style={{ marginTop: 16 }}><RamsButton variant="ghost" disabled={busy} onClick={() => { setBusy(true); void Promise.resolve(onUseSkill({ ...skill, file: current.files.find((entry) => entry.name === skill.name)!.file, source: 'o8', scope: repo ? 'project' : 'user', repoPath: repo || undefined })).finally(() => setBusy(false)); }}>Use in task</RamsButton></div> : null}</details>)}
      <p style={copy}>Use in task copies the selected instructions into your draft for any agent. Automatic loading and native plugin support vary by agent. Disable hides these skills from the library; it does not change an active task’s context. To update, import a newer version of the same bundle.</p>
    </> : <>
      <input aria-label="Search plugins" placeholder="Search plugins" value={query} onChange={(event) => setQuery(event.target.value)} style={field} />
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 400, color: 'var(--t-text)' }}>Installed</h2>
      {damaged.map((entry) => <div key={entry.id} style={{ display: 'flex', flexDirection: 'column', gap: 12, border: '1px solid var(--t-divider)', borderRadius: 12, padding: 20 }}><p style={copy}><strong>{entry.id}</strong> · {entry.message}</p>{removeDamaged === entry.id ? <><p style={copy}>Remove this damaged installation and its stored files? Independently saved skills stay in place.</p><div style={actions}><RamsButton variant="danger" busy={busy} onClick={() => void mutate({ action: 'remove', id: entry.id, revision: 'damaged' }, 'Damaged plugin removed from the library.')}>Confirm removal</RamsButton><RamsButton variant="ghost" disabled={busy} onClick={() => setRemoveDamaged(null)}>Cancel</RamsButton></div></> : <div><RamsButton variant="danger" disabled={busy} onClick={() => setRemoveDamaged(entry.id)}>Remove damaged plugin</RamsButton></div>}</div>)}
      {installed.filter((entry) => matches(entry.manifest)).length ? installed.filter((entry) => matches(entry.manifest)).map((entry) => <SkillCatalogItem key={entry.manifest.id} title={entry.manifest.name} subtitle={entry.manifest.description} pill={entry.enabled ? 'Enabled' : 'Disabled'} expanded={false} onClick={() => choose(entry.manifest)} />) : damaged.length ? null : <p style={copy}>{query ? 'No matching installed plugins.' : 'No plugins installed in this scope yet.'}</p>}
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 400, color: 'var(--t-text)' }}>Browse · o8 collection</h2>
      {catalog.filter(matches).map((entry) => <SkillCatalogItem key={entry.id} title={entry.name} subtitle={entry.description} pill={installed.some((item) => item.manifest.id === entry.id) ? 'Installed' : 'View plugin'} expanded={false} onClick={() => choose(installed.find((item) => item.manifest.id === entry.id)?.manifest ?? entry)} />)}
      <p style={copy}>This first collection contains instruction bundles. Connected-service plugins and external marketplace sources are not available yet.</p>
      <details><summary style={{ color: 'var(--t-text)', cursor: 'pointer', fontSize: 13 }}>Bundle format</summary><p style={{ ...copy, marginTop: 12 }}>Import one JSON file with format, id, name, version, description, and skills. Each skill has name, description, and instructions. No install scripts, hooks, or external files are accepted.</p><pre style={{ ...copy, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 12 }}>{JSON.stringify({ format: 'o8-instructions-v1', id: 'my-plugin', name: 'My plugin', version: '1.0.0', description: 'What this plugin helps with', skills: [{ name: 'my-skill', description: 'When to use it', instructions: 'Instructions for the agent' }] }, null, 2)}</pre></details>
    </>}
  </section>;
}
