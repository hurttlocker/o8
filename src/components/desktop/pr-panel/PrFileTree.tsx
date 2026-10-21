'use client';

import { useMemo } from 'react';
import { FileCode, Folder } from '../lucide-shims';
import type { PrFile } from './types';

interface Node { path: string; label: string; file?: PrFile; children: Map<string, Node> }
export function buildPrFileTree(files: PrFile[]): Node[] {
  const root = new Map<string, Node>();
  for (const file of files) {
    let nodes = root;
    const parts = file.path.split('/');
    parts.forEach((label, index) => {
      let node = nodes.get(label);
      if (!node) { node = { path: parts.slice(0, index + 1).join('/'), label, children: new Map() }; nodes.set(label, node); }
      if (index === parts.length - 1) node.file = file;
      nodes = node.children;
    });
  }
  return [...root.values()];
}
export function PrFileTree({ files, collapsedFolders, onToggleFolder, onSelect }: { files: PrFile[]; collapsedFolders: string[]; onToggleFolder: (path: string) => void; onSelect: (path: string) => void }) {
  const nodes = useMemo(() => buildPrFileTree(files), [files]);
  const rows = (items: Node[]): React.ReactNode => <ul style={{ margin: 0, paddingLeft: 12, listStyle: 'none' }}>
    {items.map((node) => <li key={node.path}>
      {node.file ? <button type="button" data-pr-tree-file={node.path} title={node.path} onClick={() => onSelect(node.path)} style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', minHeight: 30, paddingTop: 3, paddingRight: 6, paddingBottom: 3, paddingLeft: 0, border: 0, borderRadius: 5, color: 'var(--t-text)', background: 'transparent', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11 }}><FileCode size={13} aria-hidden="true" style={{ color: 'var(--t-accent)', flexShrink: 0 }} /><span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{node.label}</span><span style={{ color: 'var(--t-success)', fontVariantNumeric: 'tabular-nums' }}>+{node.file.additions}</span><span style={{ color: 'var(--t-danger)', fontVariantNumeric: 'tabular-nums' }}>−{node.file.deletions}</span></button> : <details open={!collapsedFolders.includes(node.path)} onToggle={(event) => { if (event.currentTarget.open === collapsedFolders.includes(node.path)) onToggleFolder(node.path); }}>
        <summary style={{ paddingTop: 6, paddingRight: 6, paddingBottom: 6, paddingLeft: 0, fontSize: 11, color: 'var(--t-text-secondary)', cursor: 'pointer' }}><Folder size={13} aria-hidden="true" style={{ verticalAlign: 'middle', marginRight: 6 }} />{node.label}</summary>
        {rows([...node.children.values()])}
      </details>}
    </li>)}
  </ul>;
  return <nav aria-label="Changed files" style={{ paddingTop: 6, paddingRight: 10, paddingBottom: 8, paddingLeft: 0 }}>{rows(nodes)}</nav>;
}
