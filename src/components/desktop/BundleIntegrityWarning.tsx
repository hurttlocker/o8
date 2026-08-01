'use client';

import { openExternalUrl } from '@/lib/desktop/open-external';
import { RELEASE_URL } from '@/lib/app-update/client-restart';

export interface BundleIntegrityStatus {
  status: 'verified' | 'invalid' | 'skipped';
  detail?: string;
  reinstallUrl?: string;
  instruction?: string;
}

export function BundleIntegrityWarning({ status }: { status: BundleIntegrityStatus }) {
  const instruction = status.instruction
    ?? 'Quit o8, move /Applications/o8.app to /Applications/o8.app.damaged, then download and reinstall the latest release.';

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        flexShrink: 0,
        marginLeft: 8,
        marginRight: 8,
        marginBottom: 6,
        paddingTop: 10,
        paddingRight: 10,
        paddingBottom: 10,
        paddingLeft: 11,
        borderRadius: 10,
        border: '1px solid var(--t-danger-border)',
        background: 'var(--t-danger-soft)',
        fontFamily: 'var(--font-sans-system)',
        color: 'var(--t-text)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            marginTop: 5,
            borderRadius: 999,
            background: 'var(--t-danger)',
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11.5, fontWeight: 400, letterSpacing: '-0.1px' }}>
            o8 needs to be reinstalled
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: 10.5,
              fontWeight: 320,
              lineHeight: 1.45,
              color: 'var(--t-text-secondary)',
              wordBreak: 'break-word',
            }}
          >
            macOS could not verify this app bundle. {instruction}
          </div>
          {status.detail ? (
            <div
              title={status.detail}
              style={{
                marginTop: 4,
                fontSize: 9.5,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                color: 'var(--t-text-faint)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {status.detail}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => openExternalUrl(status.reinstallUrl ?? RELEASE_URL)}
          style={{
            flexShrink: 0,
            minHeight: 28,
            paddingTop: 0,
            paddingRight: 10,
            paddingBottom: 0,
            paddingLeft: 10,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 6,
            border: '1px solid var(--t-danger-border)',
            background: 'var(--t-danger-soft)',
            color: 'var(--t-danger)',
            fontSize: 10.5,
            fontWeight: 400,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          Reinstall
        </button>
      </div>
    </div>
  );
}
