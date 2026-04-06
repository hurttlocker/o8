import { memo } from 'react';

function ApplyToFileModalBase({
  applyFileIndex,
  applyFileSuggestions,
  applyModal,
  applyPath,
  applyStatus,
  onApply,
  onApplyFileIndexChange,
  onApplyModalClose,
  onApplyPathChange,
  searchApplyFiles,
}: {
  applyFileIndex: number;
  applyFileSuggestions: Array<{ path: string }>;
  applyModal: { code: string; language: string } | null;
  applyPath: string;
  applyStatus: 'idle' | 'applying' | 'done' | 'error';
  onApply: () => void;
  onApplyFileIndexChange: (index: number) => void;
  onApplyModalClose: () => void;
  onApplyPathChange: (value: string) => void;
  searchApplyFiles: (query: string) => void;
}) {
  if (!applyModal) return null;

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: 'var(--cortex-dialog-overlay-padding)', paddingRight: 'var(--cortex-dialog-overlay-padding)', paddingBottom: 'var(--cortex-dialog-overlay-padding)', paddingLeft: 'var(--cortex-dialog-overlay-padding)', boxSizing: 'border-box', zIndex: 50, animation: 'llmFadeIn 150ms ease-out' }} onClick={onApplyModalClose}>
      <div style={{ background: '#ffffff', borderRadius: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.15)', width: 'min(420px, 100%)', overflow: 'hidden', animation: 'llmFadeIn 200ms ease-out' }} onClick={(event) => event.stopPropagation()}>
        <div style={{ paddingTop: 'var(--cortex-dialog-header-padding)', paddingRight: 'var(--cortex-dialog-header-padding)', paddingBottom: 'var(--cortex-dialog-header-padding)', paddingLeft: 'var(--cortex-dialog-header-padding)', borderBottom: '1px solid #f1f5f9' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#0f172a' }}>Apply to File</div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{applyModal.language} | {applyModal.code.split('\n').length} lines</div>
        </div>
        <div style={{ paddingTop: 'var(--cortex-dialog-body-padding)', paddingRight: 'var(--cortex-dialog-body-padding)', paddingBottom: 'var(--cortex-dialog-body-padding)', paddingLeft: 'var(--cortex-dialog-body-padding)', position: 'relative' }}>
          <label style={{ fontSize: 12, fontWeight: 500, color: '#64748b', display: 'block', marginBottom: 6 }}>Search for a file or type a new path</label>
          <input
            type="text"
            value={applyPath}
            onChange={(event) => {
              onApplyPathChange(event.target.value);
              searchApplyFiles(event.target.value);
            }}
            onKeyDown={(event) => {
              if (applyFileSuggestions.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  onApplyFileIndexChange(Math.min(applyFileIndex + 1, applyFileSuggestions.length - 1));
                  return;
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  onApplyFileIndexChange(Math.max(applyFileIndex - 1, 0));
                  return;
                }
                if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                  event.preventDefault();
                  onApplyPathChange(applyFileSuggestions[applyFileIndex].path);
                  return;
                }
              }
              if (event.key === 'Enter' && applyFileSuggestions.length === 0) {
                event.preventDefault();
                onApply();
              }
            }}
            placeholder="Start typing to search files..."
            autoFocus
            style={{ width: '100%', paddingTop: 10, paddingRight: 12, paddingBottom: 10, paddingLeft: 12, border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, fontFamily: 'ui-monospace, monospace', outline: 'none', boxSizing: 'border-box', transition: 'border-color 150ms' }}
            onFocus={(event) => { event.currentTarget.style.borderColor = '#3b82f6'; }}
            onBlur={(event) => { setTimeout(() => { event.currentTarget.style.borderColor = '#e2e8f0'; }, 200); }}
          />
          {applyFileSuggestions.length > 0 ? (
            <div style={{ position: 'absolute', left: 20, right: 20, top: '100%', marginTop: -12, background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.1)', maxHeight: 200, overflowY: 'auto', zIndex: 10 }}>
              {applyFileSuggestions.map((file, index) => (
                <button key={file.path} type="button" onMouseDown={(event) => { event.preventDefault(); onApplyPathChange(file.path); }} style={{ display: 'block', width: '100%', paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, border: 'none', background: index === applyFileIndex ? '#f1f5f9' : 'transparent', color: '#1e293b', fontSize: 12, fontFamily: 'ui-monospace, monospace', textAlign: 'left', cursor: 'pointer', transition: 'background 60ms' }} onMouseEnter={() => onApplyFileIndexChange(index)}>
                  {file.path}
                </button>
              ))}
            </div>
          ) : null}
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>{applyPath.trim() ? `Will write to: ${applyPath}` : 'Type to search existing files or enter a new path'}</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 'var(--cortex-dialog-footer-padding)', paddingRight: 'var(--cortex-dialog-footer-padding)', paddingBottom: 'var(--cortex-dialog-footer-padding)', paddingLeft: 'var(--cortex-dialog-footer-padding)', borderTop: '1px solid #f1f5f9' }}>
          <button type="button" onClick={onApplyModalClose} style={{ paddingTop: 8, paddingRight: 16, paddingBottom: 8, paddingLeft: 16, border: '1px solid #e2e8f0', borderRadius: 8, background: '#ffffff', color: '#64748b', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button type="button" onClick={onApply} disabled={!applyPath.trim() || applyStatus === 'applying'} style={{ paddingTop: 8, paddingRight: 16, paddingBottom: 8, paddingLeft: 16, border: 'none', borderRadius: 8, background: applyStatus === 'done' ? '#10b981' : applyStatus === 'error' ? '#ef4444' : '#3b82f6', color: '#ffffff', fontSize: 13, fontWeight: 500, cursor: applyPath.trim() ? 'pointer' : 'not-allowed', opacity: applyPath.trim() ? 1 : 0.5, transition: 'background 150ms' }}>
            {applyStatus === 'applying' ? 'Applying...' : applyStatus === 'done' ? 'Applied' : applyStatus === 'error' ? 'Error - Try Again' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

export const ApplyToFileModal = memo(ApplyToFileModalBase);
