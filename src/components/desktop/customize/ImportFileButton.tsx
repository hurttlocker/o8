'use client';

import { useRef } from 'react';
import { RamsButton } from '../settings/shared';

export function ImportFileButton({ label, accept, disabled, onImport }: {
  label: string;
  accept: string;
  disabled?: boolean;
  onImport: (file: File) => void | Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <input ref={input} aria-label={label} type="file" accept={accept} disabled={disabled} hidden onChange={(event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) void onImport(file);
    }} />
    <RamsButton variant="ghost" disabled={disabled} onClick={() => input.current?.click()} icon={
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V3m-4 4 4-4 4 4M4 15v5h16v-5" /></svg>
    }>{label}</RamsButton>
  </>;
}
