/**
 * `o8 spec …` — read + annotate a repo's o8.md review surface from outside the
 * desktop app. Every subcommand is a thin fetch to /api/repo-spec (no business
 * logic here); the vendored RFM parser lives server-side. This is the surface
 * external Claude sessions (Claude Code / Desktop / cowork) use to leave
 * thoughts on the operator's o8.md — annotate only, never overwrite the prose.
 *
 *   o8 spec read     [--repo <path>]
 *   o8 spec index    [--repo <path>]
 *   o8 spec pending  [--repo <path>]
 *   o8 spec check    [--repo <path>]
 *   o8 spec comment  [--repo <path>] --body "<msg>" [--anchor "<text>"] [--by AI]
 *   o8 spec reply    [--repo <path>] --to <id> --body "<msg>" [--by AI]
 *   o8 spec resolve  [--repo <path>] --id <id> [--summary "<txt>"]
 */

import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../output.js';

interface SpecItem {
  id: string;
  kind: string;
  author: string | null;
  status: string | null;
  text: string;
  anchorText?: string;
  parentId: string | null;
  line: number;
}
interface SpecIndex {
  items: SpecItem[];
  summary: { comments: number; replies: number; suggestions: number; unresolved: number };
}

interface SpecArgs {
  repo: string;
  to?: string;
  id?: string;
  body?: string;
  anchor?: string;
  summary?: string;
  by?: string;
}

function parseSpecArgs(rest: string[]): SpecArgs {
  const out: SpecArgs = { repo: process.cwd() };
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    const key = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    const val = eq === -1 ? (rest[++i] ?? '') : tok.slice(eq + 1);
    switch (key) {
      case 'repo': out.repo = val; break;
      case 'to': out.to = val; break;
      case 'id': out.id = val; break;
      case 'body': out.body = val; break;
      case 'anchor': out.anchor = val; break;
      case 'summary': out.summary = val; break;
      case 'by': out.by = val; break;
      default: break;
    }
  }
  return out;
}

function printItems(heading: string, items: SpecItem[], summary: SpecIndex['summary']) {
  printHumanHeading(heading);
  printHumanKv([
    ['comments', String(summary.comments)],
    ['replies', String(summary.replies)],
    ['suggestions', String(summary.suggestions)],
    ['unresolved', String(summary.unresolved)],
  ]);
  for (const it of items) {
    const mark = it.status === 'resolved' ? '✓' : '•';
    const anchor = it.anchorText ? ` @"${it.anchorText}"` : '';
    process.stdout.write(`\n  ${mark} ${it.id} [${it.kind}/${it.author ?? '?'}]${anchor}\n    ${it.text}\n`);
  }
}

export async function runSpec(mode: OutputMode, sub: string | undefined, rest: string[]): Promise<number> {
  const args = parseSpecArgs(rest);
  const cfg = resolveConfig();
  const base = '/api/repo-spec';

  switch (sub) {
    case 'read': {
      const res = await apiFetch<{ content?: string }>(cfg, base, { query: { repoPath: args.repo } });
      const content = res.data?.content ?? '';
      if (mode.human) process.stdout.write(content.endsWith('\n') ? content : `${content}\n`);
      else printJson({ schema: 'o8/cli/spec-read/v1', content });
      return EXIT.OK;
    }
    case 'index':
    case 'pending': {
      const res = await apiFetch<{ index?: SpecIndex }>(cfg, base, { query: { repoPath: args.repo, view: 'index' } });
      const index = res.data?.index ?? { items: [], summary: { comments: 0, replies: 0, suggestions: 0, unresolved: 0 } };
      const items = sub === 'pending' ? index.items.filter((i) => i.status !== 'resolved') : index.items;
      if (mode.human) printItems(sub === 'pending' ? 'pending o8.md threads' : 'o8.md review index', items, index.summary);
      else printJson({ schema: `o8/cli/spec-${sub}/v1`, summary: index.summary, items });
      return EXIT.OK;
    }
    case 'check': {
      const res = await apiFetch<{ validation?: unknown }>(cfg, base, { query: { repoPath: args.repo, view: 'validate' } });
      printJson({ schema: 'o8/cli/spec-check/v1', validation: res.data?.validation ?? null });
      return EXIT.OK;
    }
    case 'comment': {
      if (!args.body) throw new CliError('invalid_args', 'o8 spec comment requires --body.', EXIT.INVALID_ARGS);
      const res = await apiFetch<{ ok?: boolean; id?: string; error?: string }>(cfg, base, {
        method: 'POST',
        query: { repoPath: args.repo, action: 'comment' },
        body: { body: args.body, anchor: args.anchor, author: args.by },
      });
      if (!res.data?.ok) throw new CliError('comment_failed', res.data?.error ?? 'comment rejected', EXIT.CONFLICT);
      printJson({ schema: 'o8/cli/spec-comment/v1', ok: true, id: res.data.id });
      return EXIT.OK;
    }
    case 'reply': {
      if (!args.to || !args.body) throw new CliError('invalid_args', 'o8 spec reply requires --to <id> and --body.', EXIT.INVALID_ARGS);
      const res = await apiFetch<{ ok?: boolean; id?: string; error?: string }>(cfg, base, {
        method: 'POST',
        query: { repoPath: args.repo, action: 'reply' },
        body: { parentId: args.to, message: args.body, author: args.by },
      });
      if (!res.data?.ok) throw new CliError('reply_failed', res.data?.error ?? 'reply rejected', EXIT.CONFLICT);
      printJson({ schema: 'o8/cli/spec-reply/v1', ok: true, id: res.data.id });
      return EXIT.OK;
    }
    case 'resolve': {
      if (!args.id) throw new CliError('invalid_args', 'o8 spec resolve requires --id <id>.', EXIT.INVALID_ARGS);
      const res = await apiFetch<{ ok?: boolean; error?: string }>(cfg, base, {
        method: 'POST',
        query: { repoPath: args.repo, action: 'resolve' },
        body: { targetId: args.id, summary: args.summary },
      });
      if (!res.data?.ok) throw new CliError('resolve_failed', res.data?.error ?? 'resolve rejected', EXIT.CONFLICT);
      printJson({ schema: 'o8/cli/spec-resolve/v1', ok: true });
      return EXIT.OK;
    }
    default:
      throw new CliError(
        'unknown_subcommand',
        `Unknown spec subcommand: ${sub ?? '(none)'}`,
        EXIT.INVALID_ARGS,
        'Try: read | index | pending | check | comment | reply | resolve',
      );
  }
}
