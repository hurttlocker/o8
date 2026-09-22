'use client';

import { useState, type CSSProperties } from 'react';
import { parseSkillMarkdown, skillSchema } from '@/lib/customize/packages';
import { RamsButton } from '../settings/shared';
import type { CustomizeRepo } from './inventory';

export const customizationField: CSSProperties = { width: '100%', minHeight: 42, boxSizing: 'border-box', border: '1px solid var(--t-divider)', borderRadius: 10, padding: 12, background: 'var(--t-input-bg)', color: 'var(--t-text)', font: 'inherit' };
export const customizationCopy: CSSProperties = { margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--t-text-muted)' };
export function SaveScope({ repos, value, onChange, disabled, label = 'Save to' }: { label?: string; repos: CustomizeRepo[]; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 8, color: 'var(--t-text)', fontSize: 13 }}>{label}
    <select aria-label={label} disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} style={customizationField}>
      <option value="">Personal</option>{repos.map((repo) => <option key={repo.localPath} value={repo.localPath}>Repository · {repo.name}</option>)}
    </select>
  </label>;
}
export function AddSkillForm({ repos, initialRepo, onSaved, onCancel }: {
  repos: CustomizeRepo[]; initialRepo: string | null; onSaved: (repo: string | null) => void; onCancel: () => void;
}) {
  const [repo, setRepo] = useState(initialRepo ?? '');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const importFile = async (file?: File) => {
    if (!file) return;
    setBusy(true); setError('');
    try {
      if (file.size > 64 * 1024) throw new Error('Choose a SKILL.md smaller than 64 KB.');
      const skill = parseSkillMarkdown(await file.text());
      setName(skill.name); setDescription(skill.description); setInstructions(skill.instructions);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not read the file.'); }
    finally { setBusy(false); }
  };
  const save = async () => {
    const parsed = skillSchema.safeParse({ name, description, instructions });
    if (!parsed.success) { setError('Add a lowercase, hyphenated name, a description, and instructions.'); return; }
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/customize/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: repo || null, skill: parsed.data }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? 'Could not save the skill.');
      onSaved(repo || null);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not save the skill.'); }
    finally { setBusy(false); }
  };
  return <form aria-label="Add skill" onSubmit={(event) => { event.preventDefault(); void save(); }} style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: 24, border: '1px solid var(--t-divider)', borderRadius: 14 }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 400, color: 'var(--t-text)' }}>Add a skill</h2>
      <label style={{ color: 'var(--t-accent)', fontSize: 13 }}>Import SKILL.md<input aria-label="Import SKILL.md" type="file" accept=".md,text/markdown" disabled={busy} onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ''; }} style={{ display: 'block', marginTop: 8, maxWidth: '100%' }} /></label>
    </div>
    <div style={{ display: 'flex', gap: 12 }}><RamsButton variant="primary" busy={busy} onClick={() => void save()}>Save skill</RamsButton><RamsButton variant="ghost" disabled={busy} onClick={onCancel}>Cancel</RamsButton></div>
    <p style={customizationCopy}>Write reusable instructions or import a Markdown skill, then review and save. Import copies this file only; linked scripts and other files are not included.</p>
    <SaveScope repos={repos} value={repo} onChange={setRepo} disabled={busy} />
    {[['Name', name, setName, 'review-layout'], ['Description', description, setDescription, 'When should an agent use this skill?']] .map(([label, value, setter, placeholder]) => <label key={label as string} style={{ display: 'flex', flexDirection: 'column', gap: 8, color: 'var(--t-text)', fontSize: 13 }}>{label as string}<input disabled={busy} aria-label={label as string} value={value as string} placeholder={placeholder as string} maxLength={label === 'Name' ? 64 : 500} onChange={(event) => (setter as (value: string) => void)(event.target.value)} style={customizationField} /></label>)}
    <label style={{ display: 'flex', flexDirection: 'column', gap: 8, color: 'var(--t-text)', fontSize: 13 }}>Instructions<textarea aria-label="Instructions" disabled={busy} value={instructions} maxLength={48 * 1024} onChange={(event) => setInstructions(event.target.value)} rows={8} style={{ ...customizationField, resize: 'vertical', lineHeight: 1.6 }} /></label>
    <p style={customizationCopy}>Saved in the selected scope’s .agents/skills folder. Use in task adds the skill to a draft; automatic discovery depends on the agent. Only import instructions you trust.</p>
    {error ? <p role="alert" style={customizationCopy}>{error}</p> : null}

  </form>;
}
