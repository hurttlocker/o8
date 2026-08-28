import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { NodeView, NodeViewConstructor } from 'prosemirror-view';

const monoFamily = '"SF Mono",Menlo,Monaco,"Cascadia Code",ui-monospace,monospace';

function constructLabel(node: ProseMirrorNode): string {
  return String(node.attrs.construct).replaceAll('-', ' ').toUpperCase();
}

function opaqueBlockNodeView(node: ProseMirrorNode): NodeView {
  const dom = document.createElement('div');
  const label = document.createElement('div');
  const source = document.createElement('pre');

  dom.contentEditable = 'false';
  dom.dataset.opaqueConstruct = String(node.attrs.construct);
  dom.setAttribute('role', 'group');
  dom.setAttribute('aria-label', `${constructLabel(node)} source block`);
  dom.title = 'Switch to Source mode to edit this block.';
  dom.style.cssText = [
    'margin-top:0',
    'margin-right:0',
    'margin-bottom:10px',
    'margin-left:0',
    'padding-top:9px',
    'padding-right:11px',
    'padding-bottom:10px',
    'padding-left:11px',
    'border:1px solid var(--t-divider-subtle)',
    'border-radius:8px',
    'background:var(--t-input-bg)',
    'color:var(--t-text)',
    'cursor:default',
  ].join(';');

  label.textContent = constructLabel(node);
  label.style.cssText = [
    'margin-bottom:6px',
    'font-family:var(--font-sans-system)',
    'font-size:9px',
    'font-weight:300',
    'letter-spacing:0.04em',
    'line-height:14px',
    'color:var(--t-text-faint)',
  ].join(';');

  source.textContent = String(node.attrs.source);
  source.style.cssText = [
    'margin-top:0',
    'margin-right:0',
    'margin-bottom:0',
    'margin-left:0',
    'font-family:' + monoFamily,
    'font-size:12.5px',
    'font-weight:300',
    'line-height:1.5',
    'color:var(--t-text-muted)',
    'white-space:pre-wrap',
    'overflow-wrap:anywhere',
  ].join(';');

  dom.append(label, source);
  return { dom };
}

function opaqueInlineNodeView(node: ProseMirrorNode): NodeView {
  const dom = document.createElement('span');
  dom.contentEditable = 'false';
  dom.dataset.opaqueInlineConstruct = String(node.attrs.construct);
  dom.setAttribute('aria-label', `${constructLabel(node)} source`);
  dom.title = 'Switch to Source mode to edit this syntax.';
  dom.textContent = String(node.attrs.source);
  dom.style.cssText = [
    'font-family:' + monoFamily,
    'font-size:12.5px',
    'font-weight:300',
    'color:var(--t-text)',
    'white-space:pre-wrap',
  ].join(';');
  return { dom };
}

export const richMarkdownNodeViews: Record<string, NodeViewConstructor> = {
  opaque_block: (node) => opaqueBlockNodeView(node),
  opaque_inline: (node) => opaqueInlineNodeView(node),
};
