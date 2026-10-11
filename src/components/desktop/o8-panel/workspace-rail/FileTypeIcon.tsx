/** File-type hints stay on the glyph so names remain easy to scan. */
export function FileTypeIcon({ name, size = 14 }: { name: string; size?: number }) {
  const base = name.split('/').pop()?.toLowerCase() ?? '';
  const ext = base.split('.').pop() ?? '';
  const type = /^(\.gitignore|\.gitattributes|\.gitmodules)$/.test(base) ? 'git'
    : ['tsx', 'jsx'].includes(ext) ? 'react'
      : ['ts', 'js'].includes(ext) ? ext
        : ['json', 'jsonc', 'json5'].includes(ext) ? 'json'
          : ['md', 'mdx', 'markdown'].includes(ext) ? 'markdown'
            : ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'avif', 'ico'].includes(ext) ? 'image'
              : ['css', 'scss', 'sass', 'less', 'html', 'htm', 'xml'].includes(ext) ? 'markup'
                : ['py', 'rs', 'go', 'sh', 'bash', 'zsh', 'c', 'cpp', 'swift', 'rb'].includes(ext) ? 'code'
                  : ['yaml', 'yml', 'toml', 'ini', 'env'].includes(ext) || base.startsWith('.env') ? 'config' : 'file';
  const color = type === 'ts' || type === 'react' ? 'var(--t-terminal-ansi-blue)'
    : type === 'js' || type === 'json' || type === 'git' ? 'var(--t-terminal-ansi-yellow)'
      : type === 'markdown' || type === 'image' ? 'var(--t-terminal-ansi-green)'
        : type === 'markup' || type === 'code' ? 'var(--t-terminal-ansi-cyan)' : 'var(--t-text-muted)';
  return <svg aria-hidden data-file-type={type} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0, color }}>
    {type === 'ts' || type === 'js' ? <><rect x="2" y="2" width="20" height="20" rx="4" fill="currentColor" fillOpacity="0.16" stroke="none" /><text x="12" y="16" textAnchor="middle" stroke="none" fill="currentColor" fontFamily="var(--font-sans-system)" fontWeight="600" fontSize="11">{type.toUpperCase()}</text></>
      : type === 'react' ? <><ellipse cx="12" cy="12" rx="10" ry="4" /><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" /><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /></>
        : type === 'json' || type === 'config' ? <path d="M9 3H7v6c0 2-1 3-3 3 2 0 3 1 3 3v6h2m6-18h2v6c0 2 1 3 3 3-2 0-3 1-3 3v6h-2" />
          : type === 'markdown' ? <><path d="M2 18V6l4 6 4-6v12m5-7 3 4 3-4m-3 4V6" /></>
            : type === 'git' ? <><rect x="4.5" y="4.5" width="15" height="15" rx="2" transform="rotate(45 12 12)" /><path d="M9 5v9m0-5 6 6" /><circle cx="9" cy="14" r="1.4" fill="currentColor" /><circle cx="15" cy="15" r="1.4" fill="currentColor" /></>
              : type === 'image' ? <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 4-6 5 7" /></>
                : type === 'code' || type === 'markup' ? <path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18" />
                  : <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>}
  </svg>;
}
