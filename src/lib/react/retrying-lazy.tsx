'use client';

import { lazy, type ComponentType, type CSSProperties, type LazyExoticComponent } from 'react';

// React.lazy uses ComponentType<any> so ref-bearing and memoized components keep their exact prop type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LazyModule<TComponent extends ComponentType<any>> = { default: TComponent };

interface RetryingLazyOptions {
  label: string;
  retries?: number;
  delayMs?: number;
}

const fallbackShellStyle: CSSProperties = {
  display: 'flex',
  flex: 1,
  minHeight: 160,
  alignItems: 'center',
  justifyContent: 'center',
  padding: 18,
  color: 'var(--t-text)',
};

const fallbackCardStyle: CSSProperties = {
  display: 'flex',
  maxWidth: 360,
  flexDirection: 'column',
  alignItems: 'center',
  gap: 10,
  padding: 16,
  borderRadius: 18,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-divider-subtle)',
  background: 'var(--t-bg-card)',
  boxShadow: 'var(--t-shadow-soft)',
  textAlign: 'center',
};

const fallbackTitleStyle: CSSProperties = {
  margin: 0,
  color: 'var(--t-text)',
  fontSize: 14,
  fontWeight: 650,
};

const fallbackDetailStyle: CSSProperties = {
  margin: 0,
  color: 'var(--t-text-muted)',
  fontSize: 12,
  lineHeight: 1.45,
};

const fallbackButtonStyle: CSSProperties = {
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-divider-subtle)',
  borderRadius: 999,
  background: 'var(--t-input-bg)',
  color: 'var(--t-text)',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 650,
  paddingTop: 7,
  paddingBottom: 7,
  paddingLeft: 12,
  paddingRight: 12,
};

function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadWithRetries<T>(
  loader: () => Promise<T>,
  options: { retries?: number; delayMs?: number } = {},
): Promise<T> {
  const retries = Math.max(0, options.retries ?? 2);
  const delayMs = Math.max(0, options.delayMs ?? 250);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await loader();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await wait(delayMs * (attempt + 1));
      }
    }
  }

  throw lastError;
}

function LazyChunkReloadFallback({ label }: { label: string }) {
  return (
    <div role="alert" style={fallbackShellStyle}>
      <div style={fallbackCardStyle}>
        <p style={fallbackTitleStyle}>{label} needs a reload</p>
        <p style={fallbackDetailStyle}>A fresh app bundle is available. Reload to continue.</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={fallbackButtonStyle}
        >
          Reload to continue
        </button>
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function retryingLazy<TComponent extends ComponentType<any>>(
  loader: () => Promise<LazyModule<TComponent>>,
  options: RetryingLazyOptions,
): LazyExoticComponent<TComponent> {
  return lazy(async () => {
    try {
      return await loadWithRetries(loader, options);
    } catch {
      const FailedLazyChunk = () => <LazyChunkReloadFallback label={options.label} />;
      return { default: FailedLazyChunk as unknown as TComponent };
    }
  });
}
