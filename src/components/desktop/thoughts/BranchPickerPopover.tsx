'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  fetchPacketBranches,
  findCurrentPacketBranch,
  type PacketBranchInfo,
} from '@/components/desktop/thoughts/mission-panel/branchTarget';

interface BranchPickerPopoverProps {
  open: boolean;
  workspaceTargetPath: string | null;
  selectedBranch: string;
  onSelect: (branchName: string) => void;
  onClose: () => void;
}

export function BranchPickerPopover({
  open,
  workspaceTargetPath,
  selectedBranch,
  onSelect,
  onClose,
}: BranchPickerPopoverProps) {
  const [branches, setBranches] = useState<PacketBranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [createMode, setCreateMode] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setCreateMode(false);
      setNewBranchName('');
      setCreateError(null);
      return;
    }

    if (!workspaceTargetPath) {
      setBranches([]);
      setLoading(false);
      setError('Choose a repository before selecting a branch.');
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void fetchPacketBranches(workspaceTargetPath)
      .then((nextBranches) => {
        if (cancelled) return;
        setBranches(nextBranches);
      })
      .catch((fetchError) => {
        if (cancelled) return;
        const message = fetchError instanceof Error ? fetchError.message : 'Unable to load branches.';
        setError(message);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, workspaceTargetPath]);

  const filteredBranches = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return branches;
    return branches.filter((branch) => (
      branch.name.toLowerCase().includes(normalizedQuery)
      || branch.lastCommitMessage.toLowerCase().includes(normalizedQuery)
    ));
  }, [branches, query]);

  const currentBranch = findCurrentPacketBranch(branches);

  const handleCreateBranch = async () => {
    const nextBranchName = newBranchName.trim();
    if (!workspaceTargetPath || !nextBranchName) return;

    setCreating(true);
    setCreateError(null);

    try {
      const response = await fetch('/api/panel/branches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: workspaceTargetPath,
          branch: nextBranchName,
          baseBranch: currentBranch?.name ?? 'main',
        }),
      });
      const payload = await response.json().catch(() => null) as {
        created?: string;
        error?: string;
      } | null;

      if (!response.ok || !payload?.created) {
        throw new Error(payload?.error ?? 'Unable to create a branch.');
      }

      onSelect(payload.created);
      onClose();
    } catch (createBranchError) {
      const message = createBranchError instanceof Error ? createBranchError.message : 'Unable to create a branch.';
      setCreateError(message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: 38,
        left: 8,
        right: 8,
        zIndex: 30,
        borderRadius: 14,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-panel-border)',
        background: 'var(--t-panel-solid)',
        boxShadow: 'var(--t-panel-shadow)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          paddingTop: 10,
          paddingRight: 10,
          paddingBottom: 10,
          paddingLeft: 10,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider-subtle)',
          background: 'var(--t-bg-card)',
        }}
      >
        <div
          style={{
            position: 'relative',
          }}
        >
          <svg
            width={12}
            height={12}
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--t-text-faint)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              position: 'absolute',
              top: 16,
              left: 14,
              pointerEvents: 'none',
            }}
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search branches"
            style={{
              width: '100%',
              minHeight: 44,
              paddingTop: 10,
              paddingRight: 12,
              paddingBottom: 10,
              paddingLeft: 34,
              borderRadius: 12,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-input-border)',
              background: 'var(--t-input-bg)',
              color: 'var(--t-text)',
              fontSize: 13,
              fontFamily: 'system-ui, sans-serif',
              letterSpacing: '-0.01em',
              outline: 'none',
            }}
          />
        </div>
      </div>

      <div
        style={{
          maxHeight: 280,
          overflowY: 'auto',
        }}
      >
        {loading ? (
          <div
            style={{
              paddingTop: 20,
              paddingRight: 14,
              paddingBottom: 20,
              paddingLeft: 14,
              fontSize: 12,
              color: 'var(--t-text-muted)',
              letterSpacing: '-0.01em',
            }}
          >
            Loading branches...
          </div>
        ) : null}

        {!loading && error ? (
          <div
            style={{
              paddingTop: 20,
              paddingRight: 14,
              paddingBottom: 20,
              paddingLeft: 14,
              fontSize: 12,
              color: 'var(--t-text-muted)',
              letterSpacing: '-0.01em',
            }}
          >
            {error}
          </div>
        ) : null}

        {!loading && !error && filteredBranches.length === 0 ? (
          <div
            style={{
              paddingTop: 20,
              paddingRight: 14,
              paddingBottom: 20,
              paddingLeft: 14,
              fontSize: 12,
              color: 'var(--t-text-muted)',
              letterSpacing: '-0.01em',
            }}
          >
            No branches match this filter.
          </div>
        ) : null}

        {!loading && !error ? filteredBranches.map((branch) => {
          const isSelected = branch.name === selectedBranch;
          const isCurrent = branch.current;
          return (
            <button
              key={branch.name}
              type="button"
              onClick={() => {
                onSelect(branch.name);
                onClose();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                minHeight: 44,
                paddingTop: 9,
                paddingRight: 14,
                paddingBottom: 9,
                paddingLeft: 14,
                borderWidth: 0,
                borderBottomWidth: 1,
                borderBottomStyle: 'solid',
                borderBottomColor: 'var(--t-divider-subtle)',
                background: isSelected ? 'var(--t-accent-soft)' : isCurrent ? 'var(--t-bg-card)' : 'transparent',
                color: 'var(--t-text)',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <svg
                width={12}
                height={12}
                viewBox="0 0 16 16"
                fill="none"
                stroke={isSelected || isCurrent ? '#2563eb' : 'var(--t-text-faint)'}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{
                  flexShrink: 0,
                }}
              >
                <path d="M4 3.5a1.5 1.5 0 1 1 3 0a1.5 1.5 0 0 1-3 0Z" />
                <path d="M9 12.5a1.5 1.5 0 1 1 3 0a1.5 1.5 0 0 1-3 0Z" />
                <path d="M6.5 4.5h3a2 2 0 0 1 2 2v4.5" />
                <path d="M6.5 4.5v5a2 2 0 0 0 2 2h1.5" />
              </svg>
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: isSelected || isCurrent ? 700 : 600,
                      color: 'var(--t-text)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      letterSpacing: '-0.01em',
                      fontFamily: 'system-ui, sans-serif',
                    }}
                  >
                    {branch.name}
                  </span>
                  {isCurrent ? (
                    <span
                      style={{
                        flexShrink: 0,
                        paddingTop: 2,
                        paddingRight: 7,
                        paddingBottom: 2,
                        paddingLeft: 7,
                        borderRadius: 10,
                        background: 'var(--t-accent-soft)',
                        color: '#2563eb',
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '-0.01em',
                      }}
                    >
                      Current
                    </span>
                  ) : null}
                </div>
                <div
                  style={{
                    marginTop: 2,
                    fontSize: 11,
                    color: 'var(--t-text-muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    letterSpacing: '-0.01em',
                  }}
                >
                  {branch.lastCommitAge || 'Recent commit'}
                  {branch.lastCommitMessage ? ` • ${branch.lastCommitMessage}` : ''}
                </div>
              </div>
            </button>
          );
        }) : null}
      </div>

      <div
        style={{
          borderTopWidth: 1,
          borderTopStyle: 'solid',
          borderTopColor: 'var(--t-divider-subtle)',
          background: 'var(--t-bg-card)',
        }}
      >
        {createMode ? (
          <div
            style={{
              paddingTop: 10,
              paddingRight: 10,
              paddingBottom: 10,
              paddingLeft: 10,
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--t-text-muted)',
                letterSpacing: '-0.01em',
              }}
            >
              New branch from {currentBranch?.name ?? 'main'}
            </div>
            <input
              value={newBranchName}
              onChange={(event) => setNewBranchName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleCreateBranch();
                }
              }}
              placeholder="feature/branch-name"
              style={{
                width: '100%',
                minHeight: 44,
                marginTop: 8,
                paddingTop: 10,
                paddingRight: 12,
                paddingBottom: 10,
                paddingLeft: 12,
                borderRadius: 12,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-input-border)',
                background: 'var(--t-input-bg)',
                color: 'var(--t-text)',
                fontSize: 13,
                fontFamily: 'system-ui, sans-serif',
                letterSpacing: '-0.01em',
                outline: 'none',
              }}
            />
            {createError ? (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 11,
                  color: 'var(--t-text-muted)',
                  letterSpacing: '-0.01em',
                }}
              >
                {createError}
              </div>
            ) : null}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: 8,
                marginTop: 10,
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setCreateMode(false);
                  setNewBranchName('');
                  setCreateError(null);
                }}
                style={{
                  minHeight: 36,
                  paddingTop: 8,
                  paddingRight: 12,
                  paddingBottom: 8,
                  paddingLeft: 12,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--t-btn-secondary-border)',
                  background: 'transparent',
                  color: 'var(--t-text-muted)',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  letterSpacing: '-0.01em',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { void handleCreateBranch(); }}
                disabled={!newBranchName.trim() || creating}
                style={{
                  minHeight: 36,
                  paddingTop: 8,
                  paddingRight: 12,
                  paddingBottom: 8,
                  paddingLeft: 12,
                  borderRadius: 12,
                  borderWidth: 0,
                  background: '#2563eb',
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: !newBranchName.trim() || creating ? 'not-allowed' : 'pointer',
                  opacity: !newBranchName.trim() || creating ? 0.5 : 1,
                  letterSpacing: '-0.01em',
                }}
              >
                {creating ? 'Creating...' : 'Create branch'}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setCreateMode(true);
              setNewBranchName(query.trim());
              setCreateError(null);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              minHeight: 44,
              paddingTop: 10,
              paddingRight: 14,
              paddingBottom: 10,
              paddingLeft: 14,
              borderWidth: 0,
              background: 'transparent',
              color: 'var(--t-text)',
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <svg
              width={12}
              height={12}
              viewBox="0 0 16 16"
              fill="none"
              stroke="#2563eb"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                flexShrink: 0,
              }}
            >
              <path d="M8 3v10" />
              <path d="M3 8h10" />
            </svg>
            <span
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: '#2563eb',
                letterSpacing: '-0.01em',
              }}
            >
              New branch
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
