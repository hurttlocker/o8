/*
 * Vendored verbatim from @roughdraft/rfm@0.1.0 — MIT © Nathan Baschez.
 * Source: https://github.com/Lex-Inc/roughdraft (packages/rfm/src/index.ts).
 * Full license text: licenses/roughdraft-MIT.txt.
 *
 * THIRD-PARTY VENDORED CODE — kept byte-identical to upstream so we can
 * re-sync cleanly. Do NOT edit the logic here. o8-side adaptation
 * (addressing docs by repoPath -> <repoPath>/o8.md) lives in the callers
 * (API/CLI/MCP) through one canonical parser.
 * Intentionally exempt from the 800-line file ceiling: it is a frozen
 * vendored dependency, not evolving o8 code.
 */

export type RfmDiagnosticSeverity = "error" | "warning";

export interface RfmDiagnostic {
  severity: RfmDiagnosticSeverity;
  code: string;
  message: string;
  offset: number;
  line: number;
  column: number;
}

export interface RfmValidationSummary {
  comments: number;
  suggestions: number;
  legacyMetadata: number;
}

export interface RfmValidationResult {
  format: "roughdraft-flavored-markdown";
  version: "0.1";
  ok: boolean;
  diagnostics: RfmDiagnostic[];
  errors: RfmDiagnostic[];
  warnings: RfmDiagnostic[];
  summary: RfmValidationSummary;
}

export type RfmReviewItemKind = "comment" | "suggestion" | "reply";
export type RfmSuggestionKind = "addition" | "deletion" | "substitution";

export interface RfmReviewItem {
  id: string;
  kind: RfmReviewItemKind;
  suggestionKind?: RfmSuggestionKind;
  parentId: string | null;
  author: string | null;
  createdAt: string | null;
  status: string | null;
  text: string;
  originalText?: string;
  replacementText?: string;
  anchorText?: string;
  offset: number;
  endOffset: number;
  line: number;
  column: number;
}

export interface RfmReviewIndexSummary {
  comments: number;
  replies: number;
  suggestions: number;
  unresolved: number;
}

export interface RfmReviewIndex {
  format: "roughdraft-flavored-markdown";
  version: "0.1";
  items: RfmReviewItem[];
  diagnostics: RfmDiagnostic[];
  summary: RfmReviewIndexSummary;
}

export interface AppendRoughdraftReplyOptions {
  parentId: string;
  message: string;
  author?: string;
  at?: string;
  id?: string;
}

export interface MarkRoughdraftResolvedOptions {
  targetId: string;
  summary?: string;
}

interface Metadata {
  attrs: Map<string, string>;
  kind: "canonical" | "legacy";
  offset: number;
  endOffset: number;
}

const CRITICMARKUP_CLOSE_DELIMITER_PATTERN = /<<}|\+\+}|--}|~~}|==}/;

interface IdReference {
  id: string;
  kind: "comment" | "suggestion";
  offset: number;
}

interface ReplyReference {
  id: string;
  parentId: string;
  offset: number;
}

interface FenceState {
  marker: "`" | "~";
  length: number;
}

interface ParsedComment {
  content: string;
  metadata: Metadata | null;
  offset: number;
  markerEndOffset: number;
  endOffset: number;
}

interface ParsedSuggestion {
  suggestionKind: RfmSuggestionKind;
  text: string;
  originalText?: string;
  replacementText?: string;
  metadata: Metadata | null;
  offset: number;
  markerEndOffset: number;
  endOffset: number;
}

const requiredMetadataAttributes = ["id", "by", "at"] as const;
const dateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const attributeNamePattern = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function validateRoughdraftMarkdown(
  markdown: string,
): RfmValidationResult {
  const lineStarts = createLineStarts(markdown);
  const diagnostics: RfmDiagnostic[] = [];
  const ids = new Map<string, IdReference>();
  const replies: ReplyReference[] = [];
  const summary: RfmValidationSummary = {
    comments: 0,
    suggestions: 0,
    legacyMetadata: 0,
  };

  const addDiagnostic = (
    severity: RfmDiagnosticSeverity,
    code: string,
    message: string,
    offset: number,
  ) => {
    diagnostics.push({
      severity,
      code,
      message,
      offset,
      ...locationForOffset(lineStarts, offset),
    });
  };

  const validateMetadata = (
    metadata: Metadata | null,
    kind: "comment" | "suggestion",
    markerOffset: number,
  ) => {
    if (!metadata) {
      for (const attribute of requiredMetadataAttributes) {
        addDiagnostic(
          "error",
          `missing-metadata-${attribute}`,
          `Missing required metadata attribute \`${attribute}\`.`,
          markerOffset,
        );
      }
      return;
    }

    if (metadata.kind === "legacy") {
      summary.legacyMetadata += 1;
      addDiagnostic(
        "warning",
        "legacy-metadata",
        "Legacy metadata is accepted, but canonical attribute metadata is preferred.",
        metadata.offset,
      );
    }

    for (const attribute of requiredMetadataAttributes) {
      if (!metadata.attrs.get(attribute)) {
        addDiagnostic(
          "error",
          `missing-metadata-${attribute}`,
          `Missing required metadata attribute \`${attribute}\`.`,
          metadata.offset,
        );
      }
    }

    const at = metadata.attrs.get("at");
    if (at && !isValidDateTime(at)) {
      addDiagnostic(
        "error",
        "invalid-metadata-at",
        `Metadata attribute \`at\` must be an ISO 8601 date-time.`,
        metadata.offset,
      );
    }

    const id = metadata.attrs.get("id");
    if (id) {
      const existing = ids.get(id);
      if (existing) {
        addDiagnostic(
          "error",
          "duplicate-id",
          `Duplicate review id \`${id}\`.`,
          metadata.offset,
        );
      } else {
        ids.set(id, { id, kind, offset: metadata.offset });
      }
    }

    const parentId = metadata.attrs.get("re");
    if (kind === "comment" && id && parentId) {
      replies.push({ id, parentId, offset: metadata.offset });
    }
  };

  let offset = 0;
  let fence: FenceState | null = null;

  while (offset < markdown.length) {
    if (isLineStart(markdown, offset)) {
      const fenceMatch = matchFence(markdown, offset, fence);
      if (fenceMatch) {
        fence = fence ? null : fenceMatch.fence;
        offset = nextLineOffset(markdown, offset);
        continue;
      }
    }

    if (fence) {
      offset = nextLineOffset(markdown, offset);
      continue;
    }

    const codeSpanEnd = matchInlineCodeSpan(markdown, offset);
    if (codeSpanEnd !== null) {
      offset = codeSpanEnd;
      continue;
    }

    if (markdown.startsWith("{==", offset)) {
      const end = markdown.indexOf("==}", offset + 3);
      if (end === -1) {
        addDiagnostic(
          "error",
          "unclosed-highlight",
          "Highlight marker is missing closing `==}`.",
          offset,
        );
        offset += 3;
        continue;
      }

      let nextOffset = end + 3;
      let anchoredComments = 0;
      while (markdown.startsWith("{>>", nextOffset)) {
        const parsed = parseComment(markdown, nextOffset, addDiagnostic);
        if (!parsed) break;
        summary.comments += 1;
        anchoredComments += 1;
        validateMetadata(parsed.metadata, "comment", nextOffset);
        nextOffset = parsed.endOffset;
      }

      offset = anchoredComments > 0 ? nextOffset : end + 3;
      continue;
    }

    if (markdown.startsWith("{>>", offset)) {
      const parsed = parseComment(markdown, offset, addDiagnostic);
      if (parsed) {
        summary.comments += 1;
        validateMetadata(parsed.metadata, "comment", offset);
        offset = parsed.endOffset;
        continue;
      }
    }

    const parsedSuggestion = parseSuggestion(markdown, offset, addDiagnostic);
    if (parsedSuggestion) {
      summary.suggestions += 1;
      validateMetadata(parsedSuggestion.metadata, "suggestion", offset);
      offset = parsedSuggestion.endOffset;
      continue;
    }

    offset += 1;
  }

  for (const reply of replies) {
    if (reply.id === reply.parentId) {
      addDiagnostic(
        "error",
        "self-reply",
        `Comment \`${reply.id}\` must not reply to itself.`,
        reply.offset,
      );
      continue;
    }

    if (!ids.has(reply.parentId)) {
      addDiagnostic(
        "warning",
        "missing-reply-target",
        `Comment reply \`re="${reply.parentId}"\` points to a missing id.`,
        reply.offset,
      );
    }
  }

  diagnostics.sort((a, b) => a.offset - b.offset);
  const errors = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  const warnings = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "warning",
  );

  return {
    format: "roughdraft-flavored-markdown",
    version: "0.1",
    ok: errors.length === 0,
    diagnostics,
    errors,
    warnings,
    summary,
  };
}

export function extractRoughdraftReviewIndex(markdown: string): RfmReviewIndex {
  const lineStarts = createLineStarts(markdown);
  const validation = validateRoughdraftMarkdown(markdown);
  const items: RfmReviewItem[] = [];
  const noopDiagnostic = () => {};

  const addComment = (parsed: ParsedComment, anchorText?: string) => {
    const id =
      parsed.metadata?.attrs.get("id") ?? `comment-${parsed.offset.toString()}`;
    const parentId = parsed.metadata?.attrs.get("re") ?? null;

    items.push({
      id,
      kind: parentId ? "reply" : "comment",
      parentId,
      author: parsed.metadata?.attrs.get("by") ?? null,
      createdAt: parsed.metadata?.attrs.get("at") ?? null,
      status: parsed.metadata?.attrs.get("status") ?? null,
      text: parsed.content,
      anchorText,
      offset: parsed.offset,
      endOffset: parsed.endOffset,
      ...locationForOffset(lineStarts, parsed.offset),
    });
  };

  const addSuggestion = (parsed: ParsedSuggestion) => {
    const id =
      parsed.metadata?.attrs.get("id") ??
      `suggestion-${parsed.offset.toString()}`;

    items.push({
      id,
      kind: "suggestion",
      suggestionKind: parsed.suggestionKind,
      parentId: null,
      author: parsed.metadata?.attrs.get("by") ?? null,
      createdAt: parsed.metadata?.attrs.get("at") ?? null,
      status: parsed.metadata?.attrs.get("status") ?? null,
      text: parsed.text,
      originalText: parsed.originalText,
      replacementText: parsed.replacementText,
      offset: parsed.offset,
      endOffset: parsed.endOffset,
      ...locationForOffset(lineStarts, parsed.offset),
    });
  };

  let offset = 0;
  let fence: FenceState | null = null;

  while (offset < markdown.length) {
    if (isLineStart(markdown, offset)) {
      const fenceMatch = matchFence(markdown, offset, fence);
      if (fenceMatch) {
        fence = fence ? null : fenceMatch.fence;
        offset = nextLineOffset(markdown, offset);
        continue;
      }
    }

    if (fence) {
      offset = nextLineOffset(markdown, offset);
      continue;
    }

    const codeSpanEnd = matchInlineCodeSpan(markdown, offset);
    if (codeSpanEnd !== null) {
      offset = codeSpanEnd;
      continue;
    }

    if (markdown.startsWith("{==", offset)) {
      const end = markdown.indexOf("==}", offset + 3);
      if (end === -1) {
        offset += 3;
        continue;
      }

      const anchorText = markdown.slice(offset + 3, end);
      let nextOffset = end + 3;
      let anchoredComments = 0;
      while (markdown.startsWith("{>>", nextOffset)) {
        const parsed = parseComment(markdown, nextOffset, noopDiagnostic);
        if (!parsed) break;
        addComment(parsed, anchorText);
        anchoredComments += 1;
        nextOffset = parsed.endOffset;
      }

      offset = anchoredComments > 0 ? nextOffset : end + 3;
      continue;
    }

    if (markdown.startsWith("{>>", offset)) {
      const parsed = parseComment(markdown, offset, noopDiagnostic);
      if (parsed) {
        addComment(parsed);
        offset = parsed.endOffset;
        continue;
      }
    }

    const parsedSuggestion = parseSuggestion(markdown, offset, noopDiagnostic);
    if (parsedSuggestion) {
      addSuggestion(parsedSuggestion);
      offset = parsedSuggestion.endOffset;
      continue;
    }

    offset += 1;
  }

  return {
    format: "roughdraft-flavored-markdown",
    version: "0.1",
    items,
    diagnostics: validation.diagnostics,
    summary: {
      comments: items.filter((item) => item.kind === "comment").length,
      replies: items.filter((item) => item.kind === "reply").length,
      suggestions: items.filter((item) => item.kind === "suggestion").length,
      unresolved: items.filter((item) => item.status !== "resolved").length,
    },
  };
}

export function appendRoughdraftReply(
  markdown: string,
  options: AppendRoughdraftReplyOptions,
): string {
  assertSafeCommentBodyText(options.message);

  const index = extractRoughdraftReviewIndex(markdown);
  const parent = index.items.find((item) => item.id === options.parentId);
  if (!parent) {
    throw new Error(`Review item not found: ${options.parentId}`);
  }

  const reply = `{>>${options.message}<<}${serializeMetadataAttributes({
    id: options.id ?? nextCommentId(index.items),
    by: options.author ?? "AI",
    at: options.at ?? new Date().toISOString(),
    re: options.parentId,
  })}`;

  return `${markdown.slice(0, parent.endOffset)}${reply}${markdown.slice(parent.endOffset)}`;
}

function assertSafeCommentBodyText(message: string): void {
  const match = message.match(CRITICMARKUP_CLOSE_DELIMITER_PATTERN);
  if (!match) return;

  throw new Error(
    `Reply text contains CriticMarkup close delimiter "${match[0]}". Rewrite the reply without raw CriticMarkup delimiters.`,
  );
}

export function markRoughdraftResolved(
  markdown: string,
  options: MarkRoughdraftResolvedOptions,
): string {
  const index = extractRoughdraftReviewIndex(markdown);
  const target = index.items.find((item) => item.id === options.targetId);
  if (!target) {
    throw new Error(`Review item not found: ${options.targetId}`);
  }

  const metadataStart = findCanonicalMetadataStart(markdown, target.endOffset);
  if (metadataStart === null) {
    throw new Error(
      `Review item has no canonical metadata: ${options.targetId}`,
    );
  }

  const metadata = parseCanonicalMetadata(markdown, metadataStart);
  if (!metadata) {
    throw new Error(`Review item has invalid metadata: ${options.targetId}`);
  }

  metadata.attrs.set("status", "resolved");
  if (options.summary) {
    metadata.attrs.set("resolved", options.summary);
  }

  return `${markdown.slice(0, metadata.offset)}${serializeMetadataAttributes(
    Object.fromEntries(metadata.attrs),
  )}${markdown.slice(metadata.endOffset)}`;
}

function createLineStarts(markdown: string): number[] {
  const lineStarts = [0];

  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}

function locationForOffset(
  lineStarts: readonly number[],
  offset: number,
): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const lineStart = lineStarts[middle] ?? 0;
    const nextLineStart = lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY;

    if (offset < lineStart) {
      high = middle - 1;
    } else if (offset >= nextLineStart) {
      low = middle + 1;
    } else {
      return {
        line: middle + 1,
        column: offset - lineStart + 1,
      };
    }
  }

  const lastLineStart = lineStarts[lineStarts.length - 1] ?? 0;
  return {
    line: lineStarts.length,
    column: offset - lastLineStart + 1,
  };
}

function isLineStart(markdown: string, offset: number): boolean {
  return offset === 0 || markdown[offset - 1] === "\n";
}

function nextLineOffset(markdown: string, offset: number): number {
  const nextNewline = markdown.indexOf("\n", offset);
  return nextNewline === -1 ? markdown.length : nextNewline + 1;
}

function matchFence(
  markdown: string,
  offset: number,
  fence: FenceState | null,
): { fence: FenceState } | null {
  const lineEnd = nextLineOffset(markdown, offset);
  const line = markdown.slice(offset, lineEnd).replace(/\r?\n$/, "");
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  if (!match) return null;

  const markerText = match[1] ?? "";
  const marker = markerText[0] as "`" | "~";

  if (!fence) {
    return {
      fence: {
        marker,
        length: markerText.length,
      },
    };
  }

  if (fence.marker !== marker || markerText.length < fence.length) {
    return null;
  }

  return { fence };
}

function matchInlineCodeSpan(markdown: string, offset: number): number | null {
  if (markdown[offset] !== "`") return null;

  let length = 1;
  while (markdown[offset + length] === "`") {
    length += 1;
  }

  const closing = markdown.indexOf("`".repeat(length), offset + length);
  return closing === -1 ? null : closing + length;
}

function parseComment(
  markdown: string,
  offset: number,
  addDiagnostic: (
    severity: RfmDiagnosticSeverity,
    code: string,
    message: string,
    offset: number,
  ) => void,
): ParsedComment | null {
  const close = markdown.indexOf("<<}", offset + 3);
  if (close === -1) {
    addDiagnostic(
      "error",
      "unclosed-comment",
      "Comment marker is missing closing `<<}`.",
      offset,
    );
    return null;
  }

  const metadata = parseMetadata(markdown, close + 3, true, addDiagnostic);

  return {
    content: markdown.slice(offset + 3, close),
    metadata,
    offset,
    markerEndOffset: close + 3,
    endOffset: metadata?.endOffset ?? close + 3,
  };
}

function parseSuggestion(
  markdown: string,
  offset: number,
  addDiagnostic: (
    severity: RfmDiagnosticSeverity,
    code: string,
    message: string,
    offset: number,
  ) => void,
): ParsedSuggestion | null {
  const addition = parseWrappedMarker(markdown, offset, "{++", "++}");
  if (addition) {
    const metadata = parseMetadata(
      markdown,
      addition.endOffset,
      false,
      addDiagnostic,
    );
    return {
      suggestionKind: "addition",
      text: markdown.slice(offset + 3, addition.endOffset - 3),
      metadata,
      offset,
      markerEndOffset: addition.endOffset,
      endOffset: metadata?.endOffset ?? addition.endOffset,
    };
  }
  if (markdown.startsWith("{++", offset)) {
    addDiagnostic(
      "error",
      "unclosed-addition",
      "Addition marker is missing closing `++}`.",
      offset,
    );
    return null;
  }

  const deletion = parseWrappedMarker(markdown, offset, "{--", "--}");
  if (deletion) {
    const metadata = parseMetadata(
      markdown,
      deletion.endOffset,
      false,
      addDiagnostic,
    );
    const text = markdown.slice(offset + 3, deletion.endOffset - 3);
    return {
      suggestionKind: "deletion",
      text,
      originalText: text,
      metadata,
      offset,
      markerEndOffset: deletion.endOffset,
      endOffset: metadata?.endOffset ?? deletion.endOffset,
    };
  }
  if (markdown.startsWith("{--", offset)) {
    addDiagnostic(
      "error",
      "unclosed-deletion",
      "Deletion marker is missing closing `--}`.",
      offset,
    );
    return null;
  }

  if (markdown.startsWith("{~~", offset)) {
    const separator = markdown.indexOf("~>", offset + 3);
    const close =
      separator === -1 ? -1 : markdown.indexOf("~~}", separator + 2);

    if (separator === -1 || close === -1) {
      addDiagnostic(
        "error",
        "unclosed-substitution",
        "Substitution marker is missing `~>` or closing `~~}`.",
        offset,
      );
      return null;
    }

    const endOffset = close + 3;
    const metadata = parseMetadata(markdown, endOffset, false, addDiagnostic);
    return {
      suggestionKind: "substitution",
      text: markdown.slice(separator + 2, close),
      originalText: markdown.slice(offset + 3, separator),
      replacementText: markdown.slice(separator + 2, close),
      metadata,
      offset,
      markerEndOffset: endOffset,
      endOffset: metadata?.endOffset ?? endOffset,
    };
  }

  return null;
}

function parseWrappedMarker(
  markdown: string,
  offset: number,
  open: string,
  close: string,
): { endOffset: number } | null {
  if (!markdown.startsWith(open, offset)) return null;

  const closeOffset = markdown.indexOf(close, offset + open.length);
  return closeOffset === -1 ? null : { endOffset: closeOffset + close.length };
}

function parseMetadata(
  markdown: string,
  offset: number,
  allowLegacy: boolean,
  addDiagnostic: (
    severity: RfmDiagnosticSeverity,
    code: string,
    message: string,
    offset: number,
  ) => void,
): Metadata | null {
  if (allowLegacy && markdown.startsWith("{@", offset)) {
    const close = markdown.indexOf("@}", offset + 2);
    if (close === -1) {
      addDiagnostic(
        "error",
        "invalid-metadata-syntax",
        "Legacy metadata is missing closing `@}`.",
        offset,
      );
      return null;
    }

    return {
      attrs: parseLegacyAttributes(markdown.slice(offset + 2, close)),
      kind: "legacy",
      offset,
      endOffset: close + 2,
    };
  }

  if (markdown[offset] !== "{") return null;

  const parsed = parseCanonicalMetadata(markdown, offset);
  if (parsed) return parsed;

  if (looksLikeMetadata(markdown, offset)) {
    addDiagnostic(
      "error",
      "invalid-metadata-syntax",
      'Metadata must use quoted attributes such as `{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}`.',
      offset,
    );
  }

  return null;
}

function parseCanonicalMetadata(
  markdown: string,
  offset: number,
): Metadata | null {
  let cursor = offset + 1;
  const attrs = new Map<string, string>();
  let sawAttribute = false;

  while (cursor < markdown.length) {
    cursor = skipSpaces(markdown, cursor);

    if (markdown[cursor] === "}") {
      if (!sawAttribute) return null;
      return {
        attrs,
        kind: "canonical",
        offset,
        endOffset: cursor + 1,
      };
    }

    const nameStart = cursor;
    while (
      cursor < markdown.length &&
      /[A-Za-z0-9_-]/.test(markdown[cursor] ?? "")
    ) {
      cursor += 1;
    }
    const name = markdown.slice(nameStart, cursor);
    if (!attributeNamePattern.test(name) || markdown[cursor] !== "=") {
      return null;
    }
    cursor += 1;

    if (markdown[cursor] !== '"') return null;
    cursor += 1;

    let value = "";
    while (cursor < markdown.length) {
      const character = markdown[cursor];
      if (character === "\\") {
        const next = markdown[cursor + 1];
        if (next === undefined) return null;
        value += next;
        cursor += 2;
        continue;
      }

      if (character === '"') {
        cursor += 1;
        attrs.set(name, value);
        sawAttribute = true;
        break;
      }

      if (character === "\n" || character === "\r") return null;
      value += character;
      cursor += 1;
    }

    if (!attrs.has(name)) return null;
  }

  return null;
}

function parseLegacyAttributes(metadata: string): Map<string, string> {
  const attrs = new Map<string, string>();

  for (const part of metadata.split(";")) {
    const [rawKey, ...valueParts] = part.split(":");
    const key = rawKey?.trim();
    const value = valueParts.join(":").trim();
    if (!key || !value) continue;
    attrs.set(key, value);
  }

  return attrs;
}

function skipSpaces(markdown: string, offset: number): number {
  let cursor = offset;
  while (markdown[cursor] === " " || markdown[cursor] === "\t") {
    cursor += 1;
  }
  return cursor;
}

function looksLikeMetadata(markdown: string, offset: number): boolean {
  const close = markdown.indexOf("}", offset + 1);
  if (close === -1) return false;

  const content = markdown.slice(offset + 1, close);
  return /\b(?:id|by|at|re)\b/.test(content);
}

function serializeMetadataAttributes(attrs: Record<string, string>): string {
  return `{${Object.entries(attrs)
    .map(([key, value]) => `${key}="${escapeMetadataAttributeValue(value)}"`)
    .join(" ")}}`;
}

function escapeMetadataAttributeValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function nextCommentId(items: RfmReviewItem[]): string {
  let maxId = 0;

  for (const item of items) {
    const match = item.id.match(/^c(\d+)$/);
    if (!match) continue;

    const parsed = Number.parseInt(match[1] ?? "0", 10);
    maxId = Math.max(maxId, parsed);
  }

  return `c${maxId + 1}`;
}

function findCanonicalMetadataStart(
  markdown: string,
  itemEndOffset: number,
): number | null {
  let cursor = itemEndOffset - 1;

  while (cursor >= 0) {
    if (markdown[cursor] !== "{") {
      cursor -= 1;
      continue;
    }

    const parsed = parseCanonicalMetadata(markdown, cursor);
    if (parsed?.endOffset === itemEndOffset) {
      return cursor;
    }

    cursor -= 1;
  }

  return null;
}

function isValidDateTime(value: string): boolean {
  return dateTimePattern.test(value) && !Number.isNaN(Date.parse(value));
}
