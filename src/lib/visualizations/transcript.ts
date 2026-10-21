import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import { isVisualizationReference, type VisualizationReference } from './types';

/** References travel as tool results, not agent-authored markdown or executable HTML. */
export function toolVisualizationReferences(calls: MobileTranscriptToolCall[] = []): VisualizationReference[] {
  const refs = new Map<string, VisualizationReference>();
  for (const call of calls) {
    const name = call.name === 'o8_run' ? call.args?.name : call.name;
    if (typeof name !== 'string' || !/(?:^|[_.])o8_html_render$/.test(name) || !call.result || call.status === 'error' || call.result.length > 40_000) continue;
    try {
      const result = JSON.parse(call.result) as { visualization?: unknown; result?: { visualization?: unknown }; content?: Array<{ type?: string; text?: string }> };
      const ref = result.visualization ?? result.result?.visualization;
      if (isVisualizationReference(ref)) refs.set(ref.id, ref);
      for (const part of result.content ?? []) {
        if (part.type !== 'text' || !part.text) continue;
        try {
          const nested = JSON.parse(part.text) as { visualization?: unknown };
          if (isVisualizationReference(nested.visualization)) refs.set(nested.visualization.id, nested.visualization);
        } catch { /* Other text is not a visualization reference. */ }
      }
    } catch { /* Partial tool results stay in the ordinary tool strip. */ }
  }
  return [...refs.values()];
}

/** Fallback for providers that do not retain full tool results. */
export function placeTranscriptVisualizations(refs: VisualizationReference[], messages: MobileTranscriptEntry[]): Map<number, VisualizationReference[]> {
  const embedded = new Map<string, { index: number; reference: VisualizationReference }>();
  messages.forEach((message, index) => {
    for (const reference of toolVisualizationReferences(message.toolCalls)) if (!embedded.has(reference.rootId ?? reference.id)) embedded.set(reference.rootId ?? reference.id, { index, reference });
  });
  const buckets = new Map<number, VisualizationReference[]>();
  for (const ref of refs) {
    const anchor = embedded.get(ref.rootId ?? ref.id);
    if (anchor !== undefined) {
      if ((ref.version ?? 1) > (anchor.reference.version ?? 1)) {
        const bucket = buckets.get(anchor.index) ?? []; bucket.push(ref); buckets.set(anchor.index, bucket);
      }
      continue;
    }
    const time = Date.parse(ref.createdAt);
    let index = -1;
    for (let i = 0; i < messages.length; i++) {
      if ((messages[i].timestamp ?? 0) <= time) index = i;
      else break;
    }
    // A visual created during a provider turn can precede its final assistant
    // timestamp. Attach it to that reply, before the reply's actions, rather
    // than leaving it underneath the operator's prompt.
    if (messages[index]?.role !== 'assistant') {
      for (let i = index + 1; i < messages.length; i++) {
        if (messages[i].role === 'user') break;
        if (messages[i].role === 'assistant') { index = i; break; }
      }
    }
    const bucket = buckets.get(index) ?? [];
    bucket.push(ref);
    buckets.set(index, bucket);
  }
  return buckets;
}
