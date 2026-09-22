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
}

const SOURCE_LABELS: Record<SkillInventoryEntry['source'], string> = {
  o8: 'o8',
  shared: 'shared',
  codex: 'Codex',
  'claude-code': 'Claude Code',
  gemini: 'Gemini',
};

function skillsForQuery(skills: SkillInventoryEntry[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return skills;
  return skills.filter((skill) => [
    skill.name,
    skill.description,
    SOURCE_LABELS[skill.source],
    skill.scope,
  ].some((value) => value.toLowerCase().includes(normalized)));
}

export function SkillsInventoryTab({ skills, query, onOpenFile }: {
  skills: SkillInventoryEntry[];
  query: string;
  onOpenFile: (path: string) => void;
}) {
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [claudeEditorOpen, setClaudeEditorOpen] = useState(false);
  const filtered = skillsForQuery(skills, query);
  const project = filtered.filter((skill) => skill.scope === 'project');
  const user = filtered.filter((skill) => skill.scope === 'user');

  const renderRows = (entries: SkillInventoryEntry[]) => (
    <TruncatedRows rows={entries.map((skill) => (
      <Row
        key={`${skill.source}:${skill.file}`}
        title={skill.name}
        titleMono
        subtitle={skill.description}
        pill={SOURCE_LABELS[skill.source]}
        expanded={expandedFile === skill.file}
        onClick={() => setExpandedFile(expandedFile === skill.file ? null : skill.file)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <DetailLine label="Scope" value={skill.scope === 'project' ? 'Selected repository' : 'User'} />
          <DetailLine label="Source" value={SOURCE_LABELS[skill.source]} />
          <OpenFileLink file={skill.file} onOpenFile={onOpenFile} />
        </div>
      </Row>
    ))} />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ paddingTop: 16, paddingLeft: 10, paddingRight: 10, paddingBottom: 4, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <span style={{ fontSize: 13.5, fontWeight: 400, color: 'var(--t-text)' }}>Discovered skills</span>
        <span style={{ fontSize: 12, fontWeight: 300, lineHeight: 1.55, color: 'var(--t-text-secondary)' }}>
          SKILL.md files found in the selected repository and known local agent skill folders. Discovery does not mean every runtime activates a skill. This page does not install or execute skills.
        </span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={query ? 'No matching skills' : 'No skills discovered'}
          body={query
            ? 'Try another name, description, source, or scope.'
            : 'Add a SKILL.md under a supported local agent skill folder to make its metadata visible here.'}
        />
      ) : (
        <>
          {project.length > 0 ? (
            <>
              <SectionHeader label="Selected repository" count={project.length} />
              {renderRows(project)}
            </>
          ) : null}
          {user.length > 0 ? (
            <>
              <SectionHeader label="User folders" count={user.length} />
              {renderRows(user)}
            </>
          ) : null}
        </>
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
