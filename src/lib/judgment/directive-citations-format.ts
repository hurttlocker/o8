/**
 * Shapes and text for the advisory rule-citation section of the merge preview
 * (#2446). Pure: shared by the desktop row and the `o8_merge_preview` tool.
 */

export const DIRECTIVE_CITATIONS_LABEL = 'Advisory · rule citations';

/** One (file, rule) pair whose answer reached the threshold. */
export interface DirectiveCitation {
  /** The ingested directive row the rule text was read from. */
  directiveId: string;
  /** The question id: the directive id plus the rule key. */
  ruleId: string;
  /** The rule line exactly as stored in the directive, never paraphrased. */
  ruleText: string;
  path: string;
  probability: number;
  receiptId: string | null;
}

/** The `directiveCitations` field on a merge preview. Absent when the setting is off. */
export interface DirectiveCitationsPreview {
  status: 'off' | 'pending' | 'ready';
  citations: DirectiveCitation[];
  receiptIds: string[];
}

/** Plain-text section for the MCP tool; null when there is no section to show. */
export function formatDirectiveCitationsSection(preview: DirectiveCitationsPreview | undefined | null): string | null {
  if (!preview || preview.status === 'off') return null;
  const lines = [DIRECTIVE_CITATIONS_LABEL];
  if (preview.status === 'pending') {
    lines.push('Checking the changed files against the repo rules. Run the preview again for the result.');
  } else if (preview.citations.length === 0) {
    lines.push('No rule cited.');
  } else {
    for (const citation of preview.citations) {
      lines.push(`"${citation.ruleText}" · ${citation.path} · ${citation.probability.toFixed(2)} · ${citation.receiptId ?? 'no receipt'}`);
    }
  }
  return lines.join('\n');
}
