import { memo } from 'react';
import { AlertCircle, Eye, GitPullRequest, Pencil, Plus, Terminal, Trash2 } from '../lucide-shims';

import { type PendingApprovalState } from './shared';

function approvalVisual(toolName: string) {
  if (toolName === 'run_terminal_command') return { icon: <Terminal size={14} />, title: 'Run Command?', subtitle: 'You can edit before running' };
  if (toolName === 'edit_file') return { icon: <Pencil size={14} />, title: 'Apply Edit?' };
  if (toolName === 'write_file') return { icon: <Plus size={14} />, title: 'Write File?' };
  if (toolName === 'delete_file') return { icon: <Trash2 size={14} />, title: 'Delete File?' };
  if (toolName === 'create_github_issue') return { icon: <AlertCircle size={14} />, title: 'Create Issue?' };
  if (toolName === 'create_pull_request') return { icon: <GitPullRequest size={14} />, title: 'Approval Required' };
  return { icon: <Eye size={14} />, title: 'Approval Required' };
}

function ApprovalBannerBase({
  editedCommand,
  onApprovePending,
  onDenyPending,
  onEditedCommandChange,
  pendingApproval,
}: {
  editedCommand: string;
  onApprovePending: () => void;
  onDenyPending: () => void;
  onEditedCommandChange: (value: string) => void;
  pendingApproval: PendingApprovalState | null;
}) {
  if (!pendingApproval) return null;

  const approvalInfo = approvalVisual(pendingApproval.name);

  return (
    <div style={{ marginLeft: 24, marginRight: 24, marginBottom: 8, paddingTop: 14, paddingRight: 16, paddingBottom: 14, paddingLeft: 16, background: 'linear-gradient(135deg, rgba(59,130,246,0.08) 0%, rgba(99,102,241,0.06) 100%)', backdropFilter: 'blur(12px)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 12, animation: 'llmFadeIn 200ms ease-out' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ color: '#1d4ed8', display: 'inline-flex', alignItems: 'center' }}>{approvalInfo.icon}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{approvalInfo.title}</span>
        {approvalInfo.subtitle ? <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 400 }}>{approvalInfo.subtitle}</span> : null}
      </div>

      {pendingApproval.name === 'run_terminal_command' ? (
        <div style={{ marginBottom: 10 }}>
          <input
            type="text"
            value={editedCommand}
            onChange={(event) => onEditedCommandChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && editedCommand.trim()) {
                onApprovePending();
              } else if (event.key === 'Escape') {
                onDenyPending();
              }
            }}
            autoFocus
            style={{ width: '100%', paddingTop: 10, paddingRight: 12, paddingBottom: 10, paddingLeft: 12, borderRadius: 8, border: '1px solid rgba(59,130,246,0.3)', background: 'rgba(255,255,255,0.8)', color: '#0f172a', fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, monospace', outline: 'none', boxSizing: 'border-box' }}
          />
          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>{pendingApproval.summary}</div>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: '#475569', marginBottom: 10, lineHeight: 1.5 }}>{pendingApproval.summary}</div>
          {pendingApproval.diff ? (
            <div className="cortex-scroll-fade-y cortex-themed-scroll" style={{ background: 'rgba(15,23,42,0.95)', borderRadius: 8, paddingTop: 8, paddingRight: 0, paddingBottom: 8, paddingLeft: 0, marginBottom: 10, fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, monospace', maxHeight: 200, overflowY: 'auto', overflowX: 'auto' }}>
              {pendingApproval.diff.path ? <div style={{ paddingLeft: 10, paddingBottom: 6, color: '#94a3b8', borderBottom: '1px solid rgba(255,255,255,0.06)', marginBottom: 4 }}>{pendingApproval.diff.path}</div> : null}
              {(() => {
                const before = (pendingApproval.diff?.before || '').split('\n');
                const after = (pendingApproval.diff?.after || '').split('\n');
                const isNewFile = !pendingApproval.diff?.before;
                const isEdit = pendingApproval.name === 'edit_file';
                if (isNewFile) {
                  return after.slice(0, 30).map((line, index) => <div key={`new-${index}`} style={{ paddingTop: 1, paddingRight: 10, paddingBottom: 1, paddingLeft: 10, background: 'rgba(52,211,153,0.08)', color: '#6ee7b7' }}><span style={{ color: '#34d399', marginRight: 8, userSelect: 'none' }}>+</span>{line}</div>);
                }
                if (isEdit) {
                  return (
                    <>
                      {before.map((line, index) => <div key={`remove-${index}`} style={{ paddingTop: 1, paddingRight: 10, paddingBottom: 1, paddingLeft: 10, background: 'rgba(96,165,250,0.08)', color: '#93c5fd', textDecoration: 'line-through', opacity: 0.7 }}><span style={{ color: '#60a5fa', marginRight: 8, userSelect: 'none' }}>-</span>{line}</div>)}
                      {after.map((line, index) => <div key={`add-${index}`} style={{ paddingTop: 1, paddingRight: 10, paddingBottom: 1, paddingLeft: 10, background: 'rgba(52,211,153,0.08)', color: '#6ee7b7' }}><span style={{ color: '#34d399', marginRight: 8, userSelect: 'none' }}>+</span>{line}</div>)}
                    </>
                  );
                }
                return after.slice(0, 30).map((line, index) => <div key={`replace-${index}`} style={{ paddingTop: 1, paddingRight: 10, paddingBottom: 1, paddingLeft: 10, color: '#e2e8f0' }}>{line}</div>);
              })()}
              {(pendingApproval.diff?.after || '').split('\n').length > 30 ? <div style={{ paddingLeft: 10, paddingTop: 4, color: '#64748b', fontStyle: 'italic' }}>... {(pendingApproval.diff?.after || '').split('\n').length - 30} more lines</div> : null}
            </div>
          ) : pendingApproval.args && (pendingApproval.name === 'create_github_issue' || pendingApproval.name === 'create_pull_request' || pendingApproval.name === 'delete_file') ? (
            <div className="cortex-scroll-fade-y cortex-themed-scroll" style={{ background: 'rgba(255,255,255,0.6)', borderRadius: 8, paddingTop: 8, paddingRight: 10, paddingBottom: 8, paddingLeft: 10, marginBottom: 10, fontSize: 11, fontFamily: 'ui-monospace, monospace', color: '#334155', maxHeight: 80, overflowY: 'auto' }}>
              {pendingApproval.name === 'create_github_issue' ? <><div><strong>Repo:</strong> {String(pendingApproval.args.repo)}</div><div><strong>Title:</strong> {String(pendingApproval.args.title)}</div>{pendingApproval.args.labels ? <div><strong>Labels:</strong> {(pendingApproval.args.labels as string[]).join(', ')}</div> : null}</> : null}
              {pendingApproval.name === 'create_pull_request' ? <><div><strong>Repo:</strong> {String(pendingApproval.args.repo)}</div><div><strong>Branch:</strong> {String(pendingApproval.args.branch)}</div><div><strong>Title:</strong> {String(pendingApproval.args.title)}</div><div><strong>Base:</strong> {String(pendingApproval.args.baseBranch || 'main')}</div></> : null}
              {pendingApproval.name === 'delete_file' ? <div style={{ color: '#ef4444' }}><strong>File:</strong> {String(pendingApproval.args.path)}</div> : null}
            </div>
          ) : null}
        </>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" data-approve-btn="true" onClick={onApprovePending} style={{ paddingTop: 7, paddingRight: 16, paddingBottom: 7, paddingLeft: 16, borderRadius: 8, border: 'none', background: '#3b82f6', color: '#ffffff', fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'background 150ms' }} onMouseEnter={(event) => { event.currentTarget.style.background = '#2563eb'; }} onMouseLeave={(event) => { event.currentTarget.style.background = '#3b82f6'; }}>Approve</button>
        <button type="button" onClick={onDenyPending} style={{ paddingTop: 7, paddingRight: 16, paddingBottom: 7, paddingLeft: 16, borderRadius: 8, border: '1px solid #e2e8f0', background: '#ffffff', color: '#64748b', fontSize: 12, fontWeight: 500, cursor: 'pointer', transition: 'all 150ms' }} onMouseEnter={(event) => { event.currentTarget.style.borderColor = '#cbd5e1'; }} onMouseLeave={(event) => { event.currentTarget.style.borderColor = '#e2e8f0'; }}>Deny</button>
      </div>
    </div>
  );
}

export const ApprovalBanner = memo(ApprovalBannerBase);
