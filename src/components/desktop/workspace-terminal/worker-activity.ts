import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import { activityCommandWords } from './worker-command';
import { activitySearchTerms } from './worker-search';
import { activityRepetitions } from './worker-activity-groups';

export type ActivityKind = 'read' | 'search' | 'list' | 'edit' | 'diff' | 'status' | 'history' | 'test' | 'typecheck' | 'lint' | 'command';
export interface HumanActivity {
  label: string;
  liveLabel: string;
  command: string;
  files: string[];
  searchTerms: string[];
  kind: ActivityKind;
}
export interface ActivityStep extends HumanActivity {
  id: string;
  status: 'running' | 'ok' | 'failed' | 'stopped';
  reason?: string;
  startedAt?: number;
  finishedAt?: number;
}
export interface ActivityBlock {
  kind: 'activity';
  id: string;
  steps: ActivityStep[];
  summary: string;
  failed: number;
  live: boolean;
  startedAt?: number;
  finishedAt?: number;
}
export type WorkerTranscriptBlock = ActivityBlock | { kind: 'message'; id: string; entry: MobileTranscriptEntry };

const proseEntries = new WeakMap<MobileTranscriptEntry, MobileTranscriptEntry>();

function proseEntry(entry: MobileTranscriptEntry): MobileTranscriptEntry {
  if (!entry.toolCalls) return entry;
  let prose = proseEntries.get(entry);
  if (!prose) {
    prose = { ...entry, toolCalls: undefined };
    proseEntries.set(entry, prose);
  }
  return prose;
}

/** Display-only shell parsing. Never execute or interpolate the command. */
export function stripShellWrapper(raw: string | string[]): string {
  let command = Array.isArray(raw) ? raw.join(' ') : raw.trim();
  if (Array.isArray(raw) && /(?:^|\/)(?:ba|z|da)?sh$/.test(raw[0] ?? '') && /^-[a-z]*c/.test(raw[1] ?? '')) {
    command = raw.slice(2).join(' ');
  }
  for (let depth = 0; depth < 4; depth += 1) {
    const match = command.match(/^(?:\S*\/)?(?:ba|z|da)?sh\s+-[a-z]*c\s+([\s\S]+)$/);
    if (!match) break;
    command = match[1].replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return command.trim();
}

export function humanizeActivity(tool: MobileTranscriptToolCall): HumanActivity {
  const args = tool.args ?? {};
  const name = tool.name.replace(/^.*(?:__|\.)/, '').toLowerCase();
  const raw = args.command ?? args.cmd ?? args.input;
  const shell = /^(bash|shell|exec|exec_command|shell_command|run_terminal_cmd|run_user_shell_command|command_execution|terminal)$/.test(name);
  let command = shell && (typeof raw === 'string' || Array.isArray(raw))
    ? stripShellWrapper(raw as string | string[])
    : '';
  if (!command && shell && tool.preview && /^(?:Run(?:ning)?\s)/.test(tool.preview)) {
    command = stripShellWrapper(tool.preview.replace(/^Run(?:ning)?\s+/, ''));
  }
  const tokens = activityCommandWords(shell && typeof raw === 'string' ? raw : command);
  const executable = (tokens[0] ?? name).split('/').pop() ?? name;
  const searchTerms = activitySearchTerms(executable, tokens, args);
  const nativePath = args.file_path ?? args.filePath ?? args.path ?? args.filename ?? args.target_file;
  const paths = typeof nativePath === 'string' ? [nativePath] : [];
  const patch = typeof args.patch === 'string' ? args.patch : typeof raw === 'string' ? raw : command;
  if (name === 'apply_patch' || command.startsWith('apply_patch')) {
    for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) paths.push(match[1]);
  }
  if (command) {
    // File-like operands only: flags, search patterns and sed programs are not sources.
    const operands = tokens.slice(1).filter((token, index, all) => {
      if (token.startsWith('-') || searchTerms.includes(token) || /^\d+(?:,\d+)?[a-z]$/.test(token)) return false;
      if (/^(?:\d*[<>]|\/dev\/)/.test(token) || /[<>]$/.test(all[index - 1] ?? '') || token.includes('..')) return false;
      if (/^(rg|grep)$/.test(executable)) {
        const patternIndex = all.findIndex(value => !value.startsWith('-'));
        if (index === patternIndex || /^(?:-e|--regexp|-g|--glob)$/.test(all[index - 1] ?? '')) return false;
      }
      return (/^(cat|head|tail|nl|less)$/.test(executable) && !/^\d+$/.test(token) || /(?:\.[a-zA-Z][\w-]*|\/[\w.-]+)$/.test(token)) && !/^(?:https?:|\*|\^)/.test(token);
    });
    paths.push(...operands);
  }
  const files = [...new Set(paths)];
  const object = files.length === 1 ? files[0].split('/').pop()! : files.length ? `${files.length} files` : 'files';
  let kind: ActivityKind = 'command';
  let label = `Ran ${executable || 'tool'}`;
  let liveLabel = `Running ${executable || 'tool'}`;
  if (/^(cat|sed|head|tail|nl|less|read|read_file)$/.test(executable)) {
    kind = 'read'; label = `Read ${object}`; liveLabel = `Reading ${object}`;
  } else if (executable === 'git' && tokens[1] === 'grep' || /^(rg|grep|find|search|search_code|search_web|grep_search|websearch|web_search)$/.test(executable)) {
    kind = 'search'; label = 'Searched the codebase'; liveLabel = 'Searching the codebase';
    if (/web/.test(executable)) { label = 'Searched the web'; liveLabel = 'Searching the web'; }
  } else if (/^(ls|glob|list|list_files|list_directory)$/.test(executable)) {
    kind = 'list'; label = 'Listed files'; liveLabel = 'Listing files';
  } else if (/^(apply_patch|edit|write|write_file|edit_file|notebookedit)$/.test(executable)) {
    kind = 'edit'; label = `Edited ${object}`; liveLabel = `Editing ${object}`;
  } else if (executable === 'git' && /^(diff|status|log)$/.test(tokens[1] ?? '')) {
    const target = tokens[1] === 'diff' ? 'the diff' : tokens[1] === 'log' ? 'history' : 'status';
    kind = tokens[1] === 'log' ? 'history' : tokens[1] === 'diff' ? 'diff' : 'status';
    label = `Checked ${target}`; liveLabel = `Checking ${target}`;
  } else if (/^(vitest|jest|pytest)$/.test(executable) || /^(npm|pnpm|yarn|bun|cargo)$/.test(executable) && tokens.slice(1).some(token => /^test(?::|$)/.test(token))) {
    kind = 'test'; label = 'Ran tests'; liveLabel = 'Running tests';
  } else if (executable === 'tsc' || tokens.some(token => /^(typecheck|type-check)$/.test(token))) {
    kind = 'typecheck'; label = 'Type-checked'; liveLabel = 'Type-checking';
  } else if (executable === 'eslint' || tokens.some(token => token === 'lint')) {
    kind = 'lint'; label = 'Linted'; liveLabel = 'Linting';
  }
  return { label, liveLabel, files, searchTerms: kind === 'search' ? searchTerms : [], kind, command: command || `${tool.name}${typeof nativePath === 'string' ? ` ${nativePath}` : ''}` };
}

function summarize(steps: ActivityStep[]): string {
  const parts: string[] = [];
  for (const [kind, verb] of [['test', 'Ran tests'], ['typecheck', 'Type-checked'], ['lint', 'Linted'], ['read', 'Read'], ['search', 'Searched'], ['list', 'Listed'],
    ['diff', 'Checked the diff'], ['status', 'Checked status'], ['history', 'Checked history'], ['command', 'Ran'], ['edit', 'Edited']] as const) {
    const matching = steps.filter(step => step.kind === kind);
    if (!matching.length) continue;
    if (['test', 'typecheck', 'lint', 'diff', 'status', 'history'].includes(kind)) {
      parts.push(`${verb}${activityRepetitions(matching.length)}`);
      continue;
    }
    const files = new Set(matching.flatMap(step => step.files));
    const count = kind === 'read' || kind === 'edit' ? files.size || matching.length : matching.length;
    const noun = kind === 'command' ? 'command' : kind === 'search' ? 'time' : kind === 'list' ? 'directory' : 'file';
    const plural = noun === 'directory' ? 'directories' : `${noun}s`;
    parts.push(kind === 'search' && count === 1 ? 'Searched once' : `${verb} ${count} ${count === 1 ? noun : plural}`);
  }
  return parts.join(' · ');
}

/** One shared presentation model for every runtime's transcript entries. */
export function workerTranscriptBlocks(entries: MobileTranscriptEntry[], busy: boolean): WorkerTranscriptBlock[] {
  const blocks: WorkerTranscriptBlock[] = [];
  const stepsById = new Map<string, ActivityStep>();
  let pending: ActivityStep[] = [];
  const flush = () => {
    if (!pending.length) return;
    blocks.push({ kind: 'activity', id: pending[0].id, steps: pending, summary: '', failed: 0, live: false });
    pending = [];
  };
  for (const entry of entries) {
    for (const [index, tool] of (entry.toolCalls ?? []).entries()) {
      const id = tool.id || `${entry.id}:tool:${index}`;
      const existing = stepsById.get(id);
      const status = tool.status === 'error' ? 'failed' : tool.status === 'stopped' ? 'stopped'
        : tool.status === 'running' || tool.status === 'calling' ? 'running' : 'ok';
      const step: ActivityStep = {
        ...humanizeActivity({ ...tool, args: tool.args ?? (existing ? undefined : { input: entry.text }) }),
        id, status, reason: status === 'failed' || status === 'stopped' ? tool.result || tool.preview || entry.text || (status === 'stopped' ? 'Stopped' : 'Command failed') : undefined,
        startedAt: tool.startedAt ?? entry.timestamp, finishedAt: tool.finishedAt ?? (status !== 'running' ? entry.timestamp : undefined),
      };
      if (existing) {
        // Some result-only entries have neither arguments nor the original name.
        Object.assign(existing, tool.args ? { ...step, startedAt: existing.startedAt ?? step.startedAt }
          : { status, reason: step.reason, finishedAt: step.finishedAt });
      } else {
        stepsById.set(id, step);
        pending.push(step);
      }
    }
    if (entry.role !== 'tool' && (entry.text.trim() || entry.media?.length || entry.claudeCodeEvents?.length)) {
      flush();
      blocks.push({ kind: 'message', id: entry.id, entry: proseEntry(entry) });
    }
  }
  flush();
  return blocks.map((block, index) => {
    if (block.kind !== 'activity') return block;
    const starts = block.steps.flatMap(step => step.startedAt == null ? [] : [step.startedAt]);
    const ends = block.steps.flatMap(step => step.finishedAt == null ? [] : [step.finishedAt]);
    return { ...block, summary: summarize(block.steps), failed: block.steps.filter(step => step.status === 'failed').length,
      live: busy && index === blocks.length - 1,
      startedAt: starts.length ? Math.min(...starts) : undefined,
      finishedAt: ends.length ? Math.max(...ends) : undefined };
  });
}
