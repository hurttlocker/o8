'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectRecord } from './useProjects';

interface ProjectsBottomBarProps {
  projects: ProjectRecord[];
  activeProjectId: string;
  onSwitch: (projectId: string) => void;
  onCreate: (name: string) => Promise<ProjectRecord | null>;
}

function ProjectsBottomBarBase({
  projects,
  activeProjectId,
  onSwitch,
  onCreate,
}: ProjectsBottomBarProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (creating && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [creating]);

  const cancelCreate = useCallback(() => {
    setCreating(false);
    setDraftName('');
    setSubmitting(false);
  }, []);

  const submitCreate = useCallback(async () => {
    const name = draftName.trim();
    if (!name) {
      cancelCreate();
      return;
    }
    setSubmitting(true);
    const created = await onCreate(name);
    setSubmitting(false);
    if (created) cancelCreate();
  }, [cancelCreate, draftName, onCreate]);

  return (
    <div
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingTop: 8,
        paddingBottom: 8,
        paddingLeft: 14,
        paddingRight: 14,
        borderTop: '1px solid var(--t-divider-subtle)',
        background: 'var(--t-panel, transparent)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flex: 1,
          minWidth: 0,
          overflowX: 'auto',
          scrollbarWidth: 'none',
        }}
        className="hide-scrollbar"
      >
        {projects.map((project) => {
          const isActive = project.id === activeProjectId;
          const isHovered = hoveredId === project.id;
          return (
            <button
              key={project.id}
              type="button"
              title={project.name}
              onClick={() => onSwitch(project.id)}
              onMouseEnter={() => setHoveredId(project.id)}
              onMouseLeave={() => setHoveredId((current) => (current === project.id ? null : current))}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 18,
                height: 18,
                padding: 0,
                borderRadius: 999,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  width: isActive ? 7 : 6,
                  height: isActive ? 7 : 6,
                  borderRadius: '50%',
                  background: isActive
                    ? 'var(--t-text)'
                    : isHovered
                      ? 'var(--t-text-muted)'
                      : 'var(--t-text-faint)',
                  transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), width 120ms cubic-bezier(0.22, 1, 0.36, 1), height 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
              />
            </button>
          );
        })}

        {creating ? (
          <input
            ref={inputRef}
            type="text"
            value={draftName}
            disabled={submitting}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submitCreate();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelCreate();
              }
            }}
            onBlur={() => {
              if (!submitting) void submitCreate();
            }}
            placeholder="Project name"
            maxLength={60}
            style={{
              flex: 1,
              minWidth: 80,
              maxWidth: 140,
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--t-text)',
              background: 'var(--t-input-bg)',
              border: '1px solid var(--t-input-border, var(--t-divider))',
              borderRadius: 6,
              paddingTop: 3,
              paddingBottom: 3,
              paddingLeft: 8,
              paddingRight: 8,
              outline: 'none',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          />
        ) : (
          <button
            type="button"
            title="New project"
            onClick={() => setCreating(true)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 18,
              height: 18,
              borderRadius: 4,
              border: 'none',
              background: 'transparent',
              color: 'var(--t-text-faint)',
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              padding: 0,
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.color = 'var(--t-text)';
              event.currentTarget.style.background = 'var(--t-hover, rgba(148, 163, 184, 0.16))';
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.color = 'var(--t-text-faint)';
              event.currentTarget.style.background = 'transparent';
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M5 1 V9 M1 5 H9" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

export const ProjectsBottomBar = memo(ProjectsBottomBarBase);
