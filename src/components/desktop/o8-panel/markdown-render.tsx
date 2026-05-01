import type { ReactNode } from 'react';

const UI_FONT = '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    if (value.startsWith('**')) {
      nodes.push(<strong key={index} style={{ fontWeight: 700 }}>{value.slice(2, -2)}</strong>);
    } else if (value.startsWith('*')) {
      nodes.push(<em key={index}>{value.slice(1, -1)}</em>);
    } else if (value.startsWith('`')) {
      nodes.push(<code key={index} style={{ fontFamily: MONO_FONT, fontSize: '0.92em', background: 'var(--t-input-bg)', borderRadius: 8, paddingTop: 1, paddingRight: 4, paddingBottom: 1, paddingLeft: 4 }}>{value.slice(1, -1)}</code>);
    } else {
      const link = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      nodes.push(<a key={index} href={link?.[2] ?? '#'} target="_blank" rel="noreferrer" style={{ color: 'var(--t-accent)', textDecoration: 'none' }}>{link?.[1] ?? value}</a>);
    }
    last = index + value.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function MarkdownRender({ content }: { content: string }) {
  const blocks: ReactNode[] = [];
  const lines = content.split('\n');
  let code: string[] | null = null;

  lines.forEach((line, index) => {
    if (line.startsWith('```')) {
      if (code) {
        blocks.push(<pre key={`code:${index}`} style={{ marginTop: 10, marginBottom: 10, overflowX: 'auto', background: 'var(--t-input-bg)', border: '1px solid var(--t-divider-subtle)', borderRadius: 14, paddingTop: 10, paddingRight: 12, paddingBottom: 10, paddingLeft: 12 }}><code style={{ fontFamily: MONO_FONT, fontSize: 12, color: 'var(--t-text)' }}>{code.join('\n')}</code></pre>);
        code = null;
      } else {
        code = [];
      }
      return;
    }
    if (code) {
      code.push(line);
      return;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const size = level === 1 ? 22 : level === 2 ? 18 : level === 3 ? 15 : 13;
      const Tag = `h${Math.min(level, 4)}` as 'h1' | 'h2' | 'h3' | 'h4';
      blocks.push(<Tag key={index} style={{ marginTop: level === 1 ? 4 : 18, marginBottom: 8, fontFamily: UI_FONT, fontSize: size, lineHeight: 1.25, color: 'var(--t-text)', fontWeight: 700 }}>{inline(heading[2] ?? '')}</Tag>);
      return;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      const List = unordered ? 'ul' : 'ol';
      blocks.push(<List key={index} style={{ marginTop: 4, marginBottom: 4, paddingLeft: 22, color: 'var(--t-text)' }}><li style={{ marginBottom: 4 }}>{inline((unordered ?? ordered)?.[1] ?? '')}</li></List>);
      return;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push(<blockquote key={index} style={{ marginTop: 8, marginBottom: 8, marginLeft: 0, marginRight: 0, border: '1px solid var(--t-divider-subtle)', borderRadius: 12, background: 'var(--t-bg-subtle)', paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10, color: 'var(--t-text-muted)' }}>{inline(quote[1] ?? '')}</blockquote>);
      return;
    }

    blocks.push(line.trim() ? <p key={index} style={{ marginTop: 0, marginBottom: 10 }}>{inline(line)}</p> : <div key={index} style={{ height: 8 }} />);
  });

  const tailCode = code as string[] | null; if (tailCode) blocks.push(<pre key="code:tail" style={{ marginTop: 10, marginBottom: 10, overflowX: 'auto', background: 'var(--t-input-bg)', border: '1px solid var(--t-divider-subtle)', borderRadius: 14, paddingTop: 10, paddingRight: 12, paddingBottom: 10, paddingLeft: 12 }}><code style={{ fontFamily: MONO_FONT, fontSize: 12, color: 'var(--t-text)' }}>{tailCode.join('\n')}</code></pre>);

  return <div style={{ fontFamily: UI_FONT, fontSize: 13, lineHeight: 1.6, color: 'var(--t-text)' }}>{blocks}</div>;
}
