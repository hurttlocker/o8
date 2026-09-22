'use client';

import { useState } from 'react';
import { ClaudeWorkerSkills } from './ClaudeWorkerSkills';
import { DetailLine, EmptyState, OpenFileLink, Row, SectionHeader, TruncatedRows } from './shared';

export interface SkillInventoryEntry {
  name: string;
  description: string;
  scope: 'user' | 'project';
  source: 'o8' | 'shared' | 'codex' | 'claude-code' | 'gemini';
  file: string;
  repoName?: string;
  repoPath?: string;
}

const SOURCE_LABELS: Record<SkillInventoryEntry['source'], string> = {
  o8: 'o8',
  shared: 'shared',
  codex: 'Codex',
  'claude-code': 'Claude Code',
  gemini: 'Gemini',
};

interface SkillNameGroup {
  key: string;
  name: string;
  entries: SkillInventoryEntry[];
}

interface SkillScopeGroup {
  key: string;
  label: string;
  repoPath?: string;
  skillGroups: SkillNameGroup[];
}

function normalizeName(value: string) {
  return value.trim().toLowerCase();
}

function groupByName(entries: SkillInventoryEntry[], scopeKey: string): SkillNameGroup[] {
  const groups = new Map<string, SkillNameGroup>();

  entries.forEach((entry) => {
    const normalizedName = normalizeName(entry.name);
    const key = `${scopeKey}:${normalizedName}`;
    const existing = groups.get(key);
    if (existing) {
      existing.entries.push(entry);
      return;
    }
    groups.set(key, { key, name: entry.name, entries: [entry] });
  });

  return [...groups.values()];
}

function groupInventory(skills: SkillInventoryEntry[]): SkillScopeGroup[] {
  const projectGroups = new Map<string, { label: string; repoPath?: string; entries: SkillInventoryEntry[] }>();
  const personalEntries: SkillInventoryEntry[] = [];

  skills.forEach((skill) => {
    if (skill.scope === 'user') {
      personalEntries.push(skill);
      return;
    }

    const repoName = skill.repoName?.trim();
    const repoPath = skill.repoPath?.trim();
    const repoKey = repoPath || repoName || 'selected-repository';
    const existing = projectGroups.get(repoKey);
    if (existing) {
      existing.entries.push(skill);
      return;
    }
    projectGroups.set(repoKey, {
      label: repoName || repoPath || 'Selected repository',
      repoPath,
      entries: [skill],
    });
  });

  const groups: SkillScopeGroup[] = [...projectGroups.entries()].map(([repoKey, group]) => ({
    key: `project:${repoKey}`,
    label: `Project · ${group.label} · files found`,
    repoPath: group.repoPath,
    skillGroups: groupByName(group.entries, `project:${repoKey}`),
  }));

  if (personalEntries.length > 0) {
    groups.push({
      key: 'personal',
      label: 'Personal skills · files found',
      skillGroups: groupByName(personalEntries, 'personal'),
    });
  }

  return groups;
}

function skillMatchesQuery(skill: SkillInventoryEntry, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    skill.name,
    skill.description,
    SOURCE_LABELS[skill.source],
    skill.scope,
    skill.repoName,
    skill.repoPath,
  ].some((value) => value?.toLowerCase().includes(normalized));
}

function copyLabel(count: number) {
  return `${count} ${count === 1 ? 'copy' : 'copies'}`;
}

function sourceSummary(entries: SkillInventoryEntry[]) {
  const labels = [...new Set(entries.map((entry) => SOURCE_LABELS[entry.source]))];
  return `Found in ${labels.join(', ')}`;
}

export function SkillsInventoryTab({ skills, query, onOpenFile }: {
  skills: SkillInventoryEntry[];
  query: string;
  onOpenFile: (path: string) => void;
}) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [claudeEditorOpen, setClaudeEditorOpen] = useState(false);
  const groups = groupInventory(skills).map((group) => ({
    ...group,
    skillGroups: group.skillGroups.filter((skillGroup) => (
      skillGroup.entries.some((skill) => skillMatchesQuery(skill, query))
    )),
  })).filter((group) => group.skillGroups.length > 0);

  const renderRows = (skillGroups: SkillNameGroup[]) => (
    <TruncatedRows rows={skillGroups.map((skillGroup) => (
      <Row
        key={skillGroup.key}
        title={skillGroup.name}
        titleMono
        subtitle={skillGroup.entries.length === 1
          ? skillGroup.entries[0].description || sourceSummary(skillGroup.entries)
          : `${sourceSummary(skillGroup.entries)}. Expand to compare the instructions.`}
        pill={copyLabel(skillGroup.entries.length)}
        expanded={expandedGroup === skillGroup.key}
        onClick={() => setExpandedGroup(expandedGroup === skillGroup.key ? null : skillGroup.key)}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {skillGroup.entries.map((skill, index) => (
            <div
              key={`${skill.source}:${skill.file}:${index}`}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 7,
                paddingTop: index === 0 ? 0 : 10,
                marginTop: index === 0 ? 0 : 10,
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopStyle: 'solid',
                borderTopColor: 'var(--t-divider-subtle)',
              }}
            >
              <DetailLine label="Found in" value={SOURCE_LABELS[skill.source]} />
              <DetailLine label="Description" value={skill.description} />
              <DetailLine label="File" value={skill.file} mono />
              <OpenFileLink file={skill.file} onOpenFile={onOpenFile} />
            </div>
          ))}
        </div>
      </Row>
    ))} />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ paddingTop: 16, paddingLeft: 10, paddingRight: 10, paddingBottom: 4, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <span style={{ fontSize: 13.5, fontWeight: 400, color: 'var(--t-text)' }}>Discovered skills</span>
        <span style={{ fontSize: 12, fontWeight: 300, lineHeight: 1.55, color: 'var(--t-text-secondary)' }}>
          Skills give agents reusable instructions for a task. Same-name files are grouped within each repository or your personal folders. Expand a row to compare copies; finding a file here does not mean every agent loads it.
        </span>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          title={query ? 'No matching skills' : 'No skills discovered'}
          body={query
            ? 'Try another skill name, description, source, or repository name.'
            : 'Add a SKILL.md under a supported local agent skill folder to make its metadata visible here.'}
        />
      ) : (
        groups.map((group) => (
          <div key={group.key}>
            <SectionHeader
              label={group.label}
              count={group.skillGroups.reduce((total, skillGroup) => total + skillGroup.entries.length, 0)}
            />
            {renderRows(group.skillGroups)}
          </div>
        ))
      )}

      <details
        open={claudeEditorOpen}
        onToggle={(event) => setClaudeEditorOpen(event.currentTarget.open)}
        style={{ marginTop: 18, borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--t-divider-subtle)' }}
      >
        <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 10, paddingRight: 10, cursor: 'pointer', color: 'var(--t-text)' }}>
          <span style={{ fontSize: 12, fontWeight: 300 }}>Claude Code worker injection</span>
          <span style={{ fontSize: 10, fontWeight: 300, color: 'var(--t-text-muted)', borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider)', borderRadius: 999, paddingTop: 1, paddingBottom: 1, paddingLeft: 7, paddingRight: 7 }}>
            runtime-specific
          </span>
        </summary>
        {claudeEditorOpen ? <ClaudeWorkerSkills /> : null}
      </details>
    </div>
  );
}
