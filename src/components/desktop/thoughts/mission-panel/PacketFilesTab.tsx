'use client';

export function FilesTabList({ files }: { files: string[] }) {
  if (files.length === 0) {
    return (
      <div
        style={{
          paddingTop: 14,
          paddingRight: 14,
          paddingBottom: 14,
          paddingLeft: 14,
          fontSize: 11,
          color: 'var(--t-text-muted)',
          lineHeight: 1.55,
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        No allowed, predicted, or changed files are available for this packet.
      </div>
    );
  }
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 6,
        paddingRight: 6,
        paddingBottom: 6,
        paddingLeft: 6,
        fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
      }}
    >
      {files.map((file) => (
        <div
          key={file}
          style={{
            paddingTop: 4,
            paddingRight: 8,
            paddingBottom: 4,
            paddingLeft: 8,
            fontSize: 10.5,
            color: 'var(--t-text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            wordBreak: 'break-all',
          }}
          title={file}
        >
          {file}
        </div>
      ))}
    </div>
  );
}
