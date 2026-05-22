import type { ReviewChangedFile } from '@/lib/fleet/types';
import { UI_FONT, MONO_FONT, REVIEW_DRAWER_WIDTH } from './constants';
import { IconSearch, DiffStatBadge } from './icons';
import { fileDisplayParts } from './ReviewFileRow';

function FilesDrawer({
  open,
  files,
  query,
  onQueryChange,
  selectedPath,
  onSelectFile,
  onClose,
}: {
  open: boolean;
  files: ReviewChangedFile[];
  query: string;
  onQueryChange: (value: string) => void;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Review files"
      aria-hidden={!open}
      style={{
        position: 'absolute',
        top: 41,
        right: 0,
        bottom: 0,
        width: REVIEW_DRAWER_WIDTH,
        maxWidth: '72%',
        display: 'flex',
        flexDirection: 'column',
        borderLeft: '1px solid var(--t-divider-subtle)',
        background: 'var(--t-bg)',
        boxShadow: open ? '-18px 0 42px rgba(15, 23, 42, 0.08)' : 'none',
        transform: open ? 'translateX(0)' : 'translateX(102%)',
        transition: 'transform 170ms cubic-bezier(0.22, 1, 0.36, 1)',
        pointerEvents: open ? 'auto' : 'none',
        zIndex: 30,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, paddingTop: 8, paddingRight: 10, paddingBottom: 7, paddingLeft: 12, borderBottom: '1px solid var(--t-divider-subtle)', flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: UI_FONT, fontSize: 12, fontWeight: 700, color: 'var(--t-text)', lineHeight: '16px' }}>Files</div>
          <div style={{ fontFamily: UI_FONT, fontSize: 10.5, fontWeight: 600, color: 'var(--t-text-muted)', lineHeight: '14px' }}>{files.length} changed</div>
        </div>
        <button
          type="button"
          aria-label="Close files drawer"
          onClick={onClose}
          style={{
            width: 26,
            height: 26,
            border: 'none',
            borderRadius: 7,
            background: 'transparent',
            color: 'var(--t-text-muted)',
            cursor: 'pointer',
            fontFamily: UI_FONT,
            fontSize: 17,
            lineHeight: '22px',
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
        >
          ×
        </button>
      </div>
      <div style={{ paddingTop: 10, paddingRight: 10, paddingBottom: 8, paddingLeft: 10, flexShrink: 0 }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            height: 34,
            paddingLeft: 10,
            paddingRight: 10,
            borderRadius: 10,
            border: '1px solid var(--t-input-border)',
            background: 'var(--t-input-bg)',
            color: 'var(--t-text-muted)',
          }}
        >
          <IconSearch size={13} />
          <input
            type="text"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Filter files..."
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'var(--t-text)',
              fontFamily: UI_FONT,
              fontSize: 12,
              lineHeight: '16px',
              padding: 0,
            }}
          />
        </label>
      </div>
      <div className="cortex-scroll-fade-y cortex-themed-scroll cortex-inset-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingTop: 2, paddingRight: 6, paddingBottom: 12, paddingLeft: 6 }}>
        {files.length === 0 ? (
          <div style={{ paddingTop: 18, paddingRight: 10, paddingLeft: 10, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>
            No files match.
          </div>
        ) : files.map((file) => {
          const { folder, name } = fileDisplayParts(file.path);
          const active = selectedPath === file.path;
          return (
            <button
              type="button"
              key={file.path}
              title={file.path}
              onClick={() => onSelectFile(file.path)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                minHeight: 42,
                paddingTop: 5,
                paddingRight: 8,
                paddingBottom: 5,
                paddingLeft: 8,
                border: active ? '1px solid var(--t-accent)' : '1px solid transparent',
                borderRadius: 9,
                background: active ? 'var(--t-hover)' : 'transparent',
                color: 'var(--t-text)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = 'var(--t-hover)'; }}
              onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: UI_FONT, fontSize: 12, fontWeight: 650, lineHeight: '16px', color: 'var(--t-text)' }}>{name}</span>
                {folder ? <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: MONO_FONT, fontSize: 10.5, lineHeight: '14px', color: 'var(--t-text-muted)' }}>{folder}</span> : null}
              </span>
              <DiffStatBadge additions={file.additions ?? 0} deletions={file.deletions ?? 0} />
            </button>
          );
        })}
      </div>
    </aside>
  );
}

export { FilesDrawer };
