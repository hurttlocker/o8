import Image from 'next/image';

/** Local identities need no network request, including repositories without a remote. */
export function ProjectIdentity({ name, color = 'var(--t-accent)', size = 22 }: { name: string; color?: string; size?: number }) {
  if (/^o8(?:$|[-\s])/.test(name.toLowerCase())) return <Image src="/logos/o8-desktop.png" alt="" width={size} height={size} unoptimized style={{ display: 'block', objectFit: 'contain', flexShrink: 0 }} />;
  const monogram = name.trim().split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((word) => Array.from(word)[0]).join('').toUpperCase() || 'P';
  return <span aria-hidden style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, borderRadius: size * 0.25, background: `color-mix(in srgb, ${color} 16%, transparent)`, color, fontFamily: 'var(--font-sans-system)', fontSize: size * 0.43, fontWeight: 300, lineHeight: 1 }}>{monogram}</span>;
}

export function ProjectGlyph({ kind, size = 16 }: { kind: 'add' | 'folder' | 'settings' | 'chevron' | 'search' | 'check' | 'link' | 'close'; size?: number }) {
  const paths = {
    add: <><path d="M3 8V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" /><path d="M12 10v7m-3-3.5h6" /></>,
    folder: <path d="M3 8V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" />,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2" /><circle cx="15" cy="17" r="2" /></>,
    chevron: <path d="m8 10 4 4 4-4" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    link: <><path d="m10 13 4-4m-6 5-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m2 4 1-1a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block', flexShrink: 0 }}>{paths[kind]}</svg>;
}
