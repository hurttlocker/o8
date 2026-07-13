import type { MobileTranscriptToolCall } from '@/lib/mobile/types';
import { classifyToolCall } from '@/components/desktop/orchestrator/ToolCallChip';

/**
 * A single file the agent touched during a turn, distilled from a write/edit
 * tool call for the live FileEditRow stack (turn-grammar deliverable 2).
 *
 * DATA REALITY: the orchestrator stream delivers the tool INPUT (`args`) live,
 * not a git diff. So `path` is always real (from the tool's file_path arg), but
 * `added`/`removed` are only present when they can be derived HONESTLY from the
 * edit payload itself — an `Edit`/`MultiEdit` old_string→new_string line delta.
 * `Write` (whole-file overwrite, prior content unknown) and Codex `apply_patch`
 * carry no derivable counts, so those rows render `Edited <file>` with NO
 * numbers rather than inventing them (no-placeholder law).
 */
export interface FileEditRowData {
  id: string;
  path: string;
  basename: string;
  status: 'editing' | 'edited' | 'error';
  /** Lines added — present only when derivable from the edit args. */
  added?: number;
  /** Lines removed — present only when derivable from the edit args. */
  removed?: number;
}

function firstString(args: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!args) return null;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function lineCount(value: string): number {
  if (!value) return 0;
  // A trailing newline shouldn't inflate the count by a phantom empty line.
  const trimmed = value.endsWith('\n') ? value.slice(0, -1) : value;
  return trimmed.length === 0 ? 0 : trimmed.split('\n').length;
}

function basenameOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

interface EditCounts { added: number; removed: number; }

/**
 * Derive +added/−removed from the edit payload. Real numbers only:
 *  - Edit: removed = old_string lines, added = new_string lines.
 *  - MultiEdit: sum of each edit's old/new line delta.
 * Returns null for Write / apply_patch / anything without both sides — the
 * caller then renders the row without counts.
 */
export function deriveEditCounts(name: string, args: Record<string, unknown> | undefined): EditCounts | null {
  if (!args) return null;
  const lc = name.toLowerCase();

  if (lc.includes('multiedit')) {
    const edits = args.edits;
    if (!Array.isArray(edits) || edits.length === 0) return null;
    let added = 0;
    let removed = 0;
    let sawPair = false;
    for (const raw of edits) {
      if (!raw || typeof raw !== 'object') continue;
      const edit = raw as Record<string, unknown>;
      const oldStr = typeof edit.old_string === 'string' ? edit.old_string : null;
      const newStr = typeof edit.new_string === 'string' ? edit.new_string : null;
      if (oldStr === null && newStr === null) continue;
      sawPair = true;
      removed += lineCount(oldStr ?? '');
      added += lineCount(newStr ?? '');
    }
    return sawPair ? { added, removed } : null;
  }

  // Single Edit — but not Write (`write` has content, not old/new_string).
  const oldStr = typeof args.old_string === 'string' ? args.old_string : null;
  const newStr = typeof args.new_string === 'string' ? args.new_string : null;
  if (oldStr === null && newStr === null) return null;
  return { added: lineCount(newStr ?? ''), removed: lineCount(oldStr ?? '') };
}

function editStatus(status: MobileTranscriptToolCall['status']): FileEditRowData['status'] {
  if (status === 'error') return 'error';
  if (status === 'running' || status === 'calling') return 'editing';
  return 'edited';
}

/**
 * Pull the file-edit tool calls out of a turn's tool-call list. Only write/edit
 * tools that carry a real file path become rows; everything else (reads, shells,
 * delegates, and write-kind calls with no derivable path) stays in the chip
 * cluster. Returns rows in call order.
 */
export function deriveFileEdits(toolCalls: MobileTranscriptToolCall[] | undefined): FileEditRowData[] {
  if (!toolCalls || toolCalls.length === 0) return [];
  const rows: FileEditRowData[] = [];
  toolCalls.forEach((tool, index) => {
    if (classifyToolCall(tool.name).kind !== 'write') return;
    const path = firstString(tool.args, ['file_path', 'filePath', 'path', 'notebook_path']);
    if (!path) return; // no honest basename → leave it in the cluster as a chip
    const counts = deriveEditCounts(tool.name, tool.args);
    rows.push({
      id: tool.id?.trim() ? tool.id : `${tool.name}-${index}`,
      path,
      basename: basenameOf(path),
      status: editStatus(tool.status),
      ...(counts ? { added: counts.added, removed: counts.removed } : {}),
    });
  });
  return rows;
}

/** True when a tool call will render as a FileEditRow (so the cluster can skip
 *  it). Mirrors the accept condition in `deriveFileEdits`. */
export function isFileEditCall(tool: MobileTranscriptToolCall): boolean {
  if (classifyToolCall(tool.name).kind !== 'write') return false;
  return firstString(tool.args, ['file_path', 'filePath', 'path', 'notebook_path']) !== null;
}
