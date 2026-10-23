import { isValidElement, type ReactNode } from 'react';
import { renderLLMMarkdown } from '@/components/desktop/LLMMarkdown';
import { sanitizeTranscriptText } from '@/components/desktop/transcript-sanitize';
import { workerTranscriptBlocks } from '@/components/desktop/workspace-terminal/worker-activity';
import { groupActivitySteps } from '@/components/desktop/workspace-terminal/worker-activity-groups';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

type Props = { children?: ReactNode; code?: string; lang?: string; alt?: string; 'data-citation'?: string };
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
  return workerTranscriptBlocks(entries, false).map(block => block.kind === 'message'
    ? { kind: 'message', id: block.id, role: block.entry.role, nodes: markdown(block.entry.text) }
    : { kind: 'activity', id: block.id, steps: groupActivitySteps(block.steps).flatMap((group, index) => group.steps.map(step => ({
      id: step.id, command: step.command, status: step.status, ...(step.reason ? { reason: step.reason } : {}), group: index,
    }))) });
}
