import {
  buildCitationHandle,
  rowAuthority,
} from '@/lib/cortex/qa/citations';
import type { TypedRow } from '@/lib/cortex/qa/types';

export function buildFlashComposePrompt(
  question: string,
  rowsJson: string,
  options: { specIngestPresent?: boolean } = {},
): string {
  // #1122 — when a directive (D-… handle) lands at the head of the rows,
  // it's the canonical answer for this codebase-rule question. Directives
  // come from the repo's spec files (CLAUDE.md / AGENTS.md / DESIGN.md /
  // docs/**) and seed rules, and outrank any FACT- distillation that
  // contradicts them on a number, limit, or rule. The legacy "Prefer FACT-"
  // instruction sent the composer to a stale fact even when the directive
  // disagreed; this flip aligns the composer with the retrieval pin in
  // unionMerge.
  const preferenceRule = options.specIngestPresent
    ? 'When the rows include a D-… (directive) handle, prefer it as the primary citation — directives are the canonical spec for this repo and outrank any FACT- distillation that contradicts them on a number, limit, or rule. Cite FACT- rows only as supporting evidence after the directive.'
    : 'Prefer FACT- handles as primary citations.';
  return `Answer concisely (1-2 sentences) using ONLY the provided typed rows.
Question: ${question}
Rows (each row has a \`handle\` for citation, \`content\` with the actual text, and \`source_authority\` 0-1): ${rowsJson}

Rules:
1. Answer with facts clearly stated or directly entailed by row content. A row "addresses" the question only when it carries the requested fact itself, not merely matching keywords or a related topic. Quote concrete values, numbers, names, and identifiers verbatim from the content. ${preferenceRule}
2. Cite the relevant row(s) inline in [BRACKET-ID] form where BRACKET-ID is the handle field from the row (e.g. [D-014], [O-481], [PR-650], [FACT-abc123]).
3. Source-of-truth hierarchy: each row carries \`source_authority\` (0-1). When two rows contradict, cite the higher-authority one. Directives (1.0) are the project's rules — prefer them over comment opinions (0.7). Merged PRs (0.95) outrank open ones (0.8). Closed issues (0.85) outrank open ones (0.75).
4. Enumerating multiple row-stated facts is allowed and expected for specs and ownership metadata: combining a TTL row with a key-shape row, a paired-label row such as "memory/terse vs brain/verbose" with its trigger row, or a directive id with its body-stated examples and patterns is NOT inference. For output-mode questions, prefer rows that name both modes over generic rows that only mention a 'mode' parameter. When a row literally contains the requested value (a name, number, path, SHA, date, ID, runtime, owner, author, count, or failure mode) or directly entails it, answer with that value. Only refuse when no row carries the value; inference is filling in a missing value not present in any row. Do not invent or infer missing values from adjacent rows; if rows are partial, answer the supported part and name which requested value is not stated.
5. Either answer with cited literal facts OR respond with the exact string "I don't have that information yet." and nothing else.`;
}

export function buildSonnetComposeSystem(): string {
  return `You are a concise engineering assistant answering questions using ONLY provided typed rows as sources.

Rules:
1. Answer in 1-6 sentences. Be direct and specific. For multi-fact specs (latency budgets, schema/table lists, cache TTLs, output modes and triggers, configuration values, enumerated rules), scan all rows and enumerate EVERY relevant fact present in them — don't cherry-pick one and skip the rest. Combining separate row-stated facts into one list or mode/trigger pair is the canonical Class A pattern, not inference. A row that states paired labels such as "memory/terse vs brain/verbose" carries both sides of the pair; prefer it over generic rows that only mention a 'mode' parameter. Single-fact questions still get a single tight sentence.
2. Cite EVERY fact using the row's citation handle in [BRACKET-ID] form (e.g. [D-014] for directives, [O-481] for outcomes, [PR-650] for PRs). One citation per fact, inline.
3. Retrieved rows are search hits, not proof. Use a row when its fields state the fact or can be directly summarized to answer the question; matching BM25 keywords, topic overlap, or a real citation handle is not enough.
4. Source-of-truth hierarchy: each row carries \`source_authority\` (0-1). When two rows contradict, cite the higher-authority one. Directives (1.0) are the project's rules — prefer them over comment opinions (0.7). Merged PRs (0.95) outrank open ones (0.8). Closed issues (0.85) outrank open ones (0.75).
5. Rows with citation handle prefix \`FACT-\` are pre-extracted facts (high confidence). Prefer them only when they answer or directly support the question; otherwise ignore them or use a better raw row.
6. When a row literally contains the requested value (a name, number, path, SHA, date, ID, runtime, owner, author, count, or failure mode) or directly entails it, answer with that value — the anti-inference rule does NOT mean refusing on supported answers. For directive ownership/enforcement questions, answer with the specific directive id/title as the owner/enforcer and include body-stated reference implementations, examples, or named patterns; do not add a "no human owner" caveat unless the question asks for a person or team. Only refuse when no row carries the value. Do not invent or infer missing values from adjacent rows; if rows are partial, answer the supported part and name the missing value. Related incidents or broad category rows are not partial answers to named-rule, owner, author, count, or ID questions unless they name the requested thing. If rows genuinely don't answer the question, say exactly: "I don't have that information yet — try indexing more directives or PRs." and nothing else.
7. Stream your answer token by token.`;
}

export function buildSonnetComposeUser(
  question: string,
  repoPath: string | undefined,
  rows: TypedRow[],
): string {
  // #915 path-to-70 round-2 fix: was slice(0, 20), but retrieve.ts merges to
  // MERGE_LIMIT = 30. Project rows from emitProjectRows landed at ranks 21-24
  // and got truncated here — ownership stayed at 35% despite PR #949 paying
  // the bill. Match the merge ceiling.
  const rowsJson = JSON.stringify(
    rows.slice(0, 30).map((r) => ({
      citationHandle: buildCitationHandle(r),
      kind: r.citation.kind,
      excerpt: r.citation.excerpt ?? '',
      // Source-of-truth hierarchy (#915 follow-up). Top-level so the model
      // doesn't have to reach into `fields` for it.
      source_authority: rowAuthority(r),
      fields: r.fields,
    })),
    null,
    2,
  );

  const repoLine = repoPath ? `\nRepo: ${repoPath}` : '';
  return `Question: ${question}${repoLine}\n\nAvailable rows:\n${rowsJson}`;
}

