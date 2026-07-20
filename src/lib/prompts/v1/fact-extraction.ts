export const STRICT_JSON_SYSTEM_PROMPTS_V1 = Object.freeze({
  textFacts: 'You extract structured facts from text. Output strict JSON only.',
  documentationFacts: 'You extract structured facts from documentation. Output strict JSON only. No prose, no fences, no preamble.',
  classifier: 'You are a strict classifier. Return only the JSON object specified.',
  evaluator: 'You are a strict evaluator. Return only valid JSON matching the requested schema.',
});

export const COMMENT_FACT_EXTRACTION_PROMPT_TEMPLATE_V1 = `You are extracting structured facts from a single GitHub comment in an engineering organization.

Read the COMMENT BODY below and emit a JSON array of facts. Each fact is one self-contained piece of organizational knowledge — a decision, spec, process, incident, ownership claim, cross-repo invariant, or directive. If the comment is purely conversational ("ok", "thanks", "lgtm"), reactionary, or contains no extractable factual content, emit an empty array [].

Output format — STRICT JSON, no prose, no code fences, no explanation:

[
  {
    "kind": "decision" | "spec" | "process" | "incident" | "ownership" | "cross_repo" | "directive" | "other",
    "content": "<1-2 sentences, self-contained, no pronouns referring to context, max 500 chars>",
    "source_excerpt": "<verbatim substring of the COMMENT BODY, max 200 chars, case-sensitive char-for-char match>",
    "confidence": <number 0.0-1.0; 1.0 = explicit statement, 0.7 = clear inference, 0.4 = ambiguous>
  }
]

Hard rules — facts that violate these will be silently rejected, so don't emit them:
- source_excerpt MUST be a verbatim, case-sensitive, character-for-character substring of the COMMENT BODY. No paraphrasing, no truncation markers, no quotation reformatting.
- content must NOT invent information not present in the comment. If a name, number, repo, or file isn't in the body, don't put it in the fact.
- content must be self-contained — readable without seeing the comment.
- Confidence below 0.6 will be dropped, so don't emit facts you're not at least somewhat sure about.

Kind selector:
- decision   — "we decided X over Y", "locked on X", "rejected proposal Z"
- spec       — schemas, table names, command syntax, type definitions, numeric thresholds
- process    — workflow steps, commands run before commit, release cadence, review rules
- incident   — "X broke when Y", failure modes, postmortem notes
- ownership  — who owns what, who reviews what, what project contains what
- cross_repo — invariants spanning multiple repos (design language, tokens, contracts)
- directive  — "must always do X", "never Y", explicit organizational rules
- other      — factual content that doesn't fit above but is still organizational knowledge

COMMENT BODY:
<<<
{BODY}
>>>

Output JSON array only:`;

export function buildCommentFactExtractionPromptV1(body: string): string {
  const safeBody = body.length > 8_000 ? body.slice(0, 8_000) : body;
  return COMMENT_FACT_EXTRACTION_PROMPT_TEMPLATE_V1.replace('{BODY}', safeBody);
}

export interface DocumentationFactPromptChunkV1 {
  id: string;
  repoName: string;
  relPath: string;
  headingPath: string[];
  text: string;
}

export function buildDocumentationFactExtractionPromptV1(
  chunks: DocumentationFactPromptChunkV1[],
): string {
  const formatted = chunks.map((chunk) => ({
    id: chunk.id,
    path: `${chunk.repoName}/${chunk.relPath}`,
    heading: chunk.headingPath.join(' > '),
    text: chunk.text,
  }));

  return `You are extracting structured facts from documentation chunks. Each chunk has an id; for each chunk return zero or more facts as JSON.

Output format — STRICT JSON, one object, no prose, no fences:

{
  "<chunk_id>": [
    {
      "kind": "decision" | "spec" | "process" | "incident" | "ownership" | "cross_repo" | "directive" | "other",
      "content": "<one declarative sentence quoting concrete values, max 500 chars>",
      "source_excerpt": "<8-30 word verbatim substring of THAT chunk's text>",
      "confidence": <number 0.0-1.0>
    }
  ],
  "<chunk_id>": [],
  ...
}

Rules:
- Each fact is ONE declarative sentence quoting concrete values (file paths, table names, env vars, commands, numbers).
- Skip a chunk (return []) if it is a table of contents, navigation, license boilerplate, or pure markdown structure.
- source_excerpt MUST be a verbatim, case-sensitive, character-for-character substring of THAT chunk's text. No paraphrasing.
- content must NOT invent information not present in the chunk.
- content must be self-contained — readable without the chunk.
- Confidence below 0.6 will be dropped, so don't emit facts you're not at least somewhat sure about.

Kind selector:
- decision   — "we decided X over Y", "locked on X", "rejected Z"
- spec       — schemas, table names, command syntax, type definitions, numeric thresholds, config keys
- process    — workflow steps, commands run before commit, release cadence, review rules
- incident   — "X broke when Y", failure modes, postmortem notes
- ownership  — who owns what, who reviews what, what project contains what
- cross_repo — invariants spanning multiple repos (design language, tokens, contracts)
- directive  — "must always do X", "never Y", explicit organizational rules
- other      — factual content that doesn't fit above but is still organizational knowledge

Chunks:
${JSON.stringify(formatted, null, 2)}

Output JSON object only:`;
}

export function buildCommitFactExtractionPromptV1(
  sha: string,
  message: string,
  files: string[],
): string {
  const fileSummary = files.length === 0
    ? '(no changed files listed)'
    : files.slice(0, 40).join('\n') + (files.length > 40 ? `\n…and ${files.length - 40} more` : '');

  return `You are extracting structured facts from a single git commit.

Read the COMMIT below and emit a JSON array of facts. Each fact is one self-contained piece of engineering knowledge: a decision, spec, process change, architecture note, or directive. If the commit message is purely mechanical ("fix typo", "bump version", "merge", "chore"), emit an empty array [].

Output format — STRICT JSON, no prose, no code fences:

[
  {
    "kind": "decision" | "spec" | "process" | "incident" | "ownership" | "cross_repo" | "directive" | "other",
    "content": "<1-2 sentences, self-contained, concrete, max 400 chars>",
    "source_excerpt": "<verbatim substring of the COMMIT MESSAGE below, max 150 chars>",
    "confidence": <number 0.0-1.0; 1.0 = explicit statement, 0.7 = clear inference>
  }
]

Hard rules — violating these will silently reject the fact:
- source_excerpt MUST be a verbatim, case-sensitive, character-for-character substring of the COMMIT MESSAGE.
- content must be self-contained — readable without seeing the commit.
- content must NOT invent information not present in the commit message.
- Confidence below 0.6 will be dropped, so don't emit facts you're not sure about.

Kind selector:
- decision   — "chose X over Y", "locked on X", "rejected Z"
- spec       — schemas, file conventions, command syntax, numeric thresholds
- process    — workflow steps, build/release steps, review rules
- incident   — "broke when Y", failure modes, postmortem notes
- ownership  — who owns what, what component contains what
- cross_repo — invariants across multiple repos
- directive  — "must always do X", "never Y", explicit project rules
- other      — factual engineering content that doesn't fit above

COMMIT SHA: ${sha}

COMMIT MESSAGE:
<<<
${message.slice(0, 4000)}
>>>

CHANGED FILES (context only — do not hallucinate facts from filenames alone):
${fileSummary}

Output JSON array only:`;
}
