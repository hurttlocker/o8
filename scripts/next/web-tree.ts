import { isValidElement, type ReactNode, type CSSProperties } from 'react';
import { renderLLMMarkdown } from '@/components/desktop/LLMMarkdown';
import { sanitizeTranscriptText } from '@/components/desktop/transcript-sanitize';
import { workerTranscriptBlocks } from '@/components/desktop/workspace-terminal/worker-activity';
import { groupActivitySteps } from '@/components/desktop/workspace-terminal/worker-activity-groups';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { composeWorkspaceChatTranscript } from '@/components/desktop/workspace-terminal/WorkspaceTranscript';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { HandoffTranscriptCard } from '@/components/desktop/thoughts/chat-panel/HandoffTranscriptCard';
import { CompactionNode } from '@/components/desktop/CompactionNode';

type Props = { children?: ReactNode; code?: string; lang?: string; alt?: string; style?: CSSProperties; 'data-citation'?: string };
type Run = { style: string; text: string };
function inline(node: ReactNode): Run[] {
  if (node == null || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [{ style: 'text', text: String(node) }];
  if (Array.isArray(node)) return node.flatMap(inline);
  if (!isValidElement<Props>(node)) throw new Error('Unknown inline node');
  const type = node.type;
  const style = type === 'strong' ? 'strong' : type === 'em' ? 'em' : type === 's' ? 'strike'
    : type === 'code' ? 'code' : type === 'a' || type === 'button' ? 'link'
      : type === 'img' ? 'image' : node.props['data-citation'] ? 'citation' : null;
  if (!style) return inline(node.props.children);
  const text = style === 'image' ? node.props.alt ?? 'image' : style === 'citation' ? node.props['data-citation']! : inline(node.props.children).map(run => run.text).join('');
  return [{ style, text }];
}
function markdown(text: string) {
  return renderLLMMarkdown(sanitizeTranscriptText(text), { compact: true }).map(node => {
    if (!isValidElement<Props>(node)) throw new Error('Unknown markdown node');
    const key = String(node.key);
    if (key.startsWith('diff-')) return { kind: 'diff-card', runs: [{ style: 'code', text: node.props.code! }], language: 'diff' };
    if (key.startsWith('table-')) {
      const descendants = (value: ReactNode, type: string): React.ReactElement<Props>[] => {
        if (Array.isArray(value)) return value.flatMap(child => descendants(child, type));
        if (!isValidElement<Props>(value)) return [];
        return [...(value.type === type ? [value] : []), ...descendants(value.props.children, type)];
      };
      const headers = descendants(node, 'th');
      const rows = descendants(node, 'tbody').flatMap(body => descendants(body, 'tr'));
      return { kind: 'table', runs: [], data: { headers: headers.map(cell => inline(cell.props.children)),
        aligns: headers.map(cell => cell.props.style?.textAlign ?? 'left'),
        rows: rows.map(row => descendants(row, 'td').map(cell => inline(cell.props.children))) } };
    }
    if (key.startsWith('code-') && node.props.code !== undefined) {
      return { kind: 'code-block', runs: [{ style: 'code', text: node.props.code }], language: node.props.lang ?? '' };
    }
    const prefix = key.split('-')[0];
    const kind = prefix === 'br' ? 'break' : prefix === 'hr' ? 'rule' : prefix === 'q' ? 'quote' : prefix;
    if (kind === 'break' || kind === 'rule') return { kind, runs: [] };
    if (kind === 'ul' || kind === 'ol') {
      const children = node.props.children as ReactNode[];
      const marker = inline(children[0]).map(run => run.text).join('');
      return { kind: kind === 'ol' ? `ol:${marker}` : 'ul', runs: inline(children[1]) };
    }
    if (!['p', 'h1', 'h2', 'h3', 'h4', 'quote'].includes(kind)) throw new Error(`Outside parity scope: ${key}`);
    return { kind, runs: inline(node.props.children) };
  });
}

/** Project actual production React elements, not a second Markdown parser. */
export function webTree(entries: MobileTranscriptEntry[]) {
  const items = composeWorkspaceChatTranscript(entries);
  return workerTranscriptBlocks(entries, false).map(block => block.kind === 'message'
    ? items.find(item => item.key === block.id)?.kind === 'packet-header'
      ? { kind: 'packet-header', id: block.id, prompt: block.entry.text }
      : { kind: 'message', id: block.id, role: block.entry.role, nodes: eventNodes(block.entry) }
    : { kind: 'activity', id: block.id, steps: groupActivitySteps(block.steps).flatMap((group, index) => group.steps.map(step => ({
      id: step.id, command: step.command, status: step.status, ...(step.reason ? { reason: step.reason } : {}), group: index,
    }))) });
}

function eventNodes(entry: MobileTranscriptEntry) {
  const nodes = [];
  if (entry.type === 'handoff' && entry.handoff) {
    const html = renderToStaticMarkup(createElement(HandoffTranscriptCard, { handoff: entry.handoff }));
    if (!html.includes('handed off to')) throw new Error('Production handoff renderer did not render the receipt');
    nodes.push({ kind: 'handoff', runs: [], data: entry.handoff });
  } else if (entry.type === 'compaction' && entry.compaction) {
    const html = renderToStaticMarkup(createElement(CompactionNode, entry.compaction));
    if (!html.includes('Context compacted')) throw new Error('Production compaction renderer did not render the receipt');
    nodes.push({ kind: 'compaction', runs: [], data: entry.compaction });
  } else if (entry.text) nodes.push(...markdown(entry.text));
  for (const media of entry.media ?? []) nodes.push({ kind: 'media', runs: [], data: media });
  return nodes;
}
