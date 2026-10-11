#!/usr/bin/env node

// Credit outside contributors by GitHub handle when their pull request ships
// (#3459). A handle is credited only when the pull request author is not a bot
// and holds less than write permission on the repository, so maintainers and
// automation never appear. Every lookup failure skips the credit: a missing
// thank-you is fixable, a release that fails on a GitHub hiccup is not.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAINTAINER_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** The pull request a squash-merge subject names: the last `(#n)` before an optional `[via-o8]`. */
export function pullNumberFromSubject(subject) {
  const match = String(subject ?? '').match(/\(#(\d+)\)\s*(?:\[via-o8\])?\s*$/i);
  return match ? Number(match[1]) : null;
}

/**
 * Map pull request number → credited login.
 * `pullAuthors` maps a number to `{ login, isBot }`; `permissionFor(login)`
 * returns the repository permission string, or throws when it can't be read.
 */
export function resolveContributorCredits(pullNumbers, { pullAuthors, permissionFor }) {
  const credits = {};
  const permissions = new Map();
  for (const number of new Set(pullNumbers)) {
    const author = pullAuthors.get(number);
    const login = author?.login;
    if (!login || author.isBot || login.endsWith('[bot]') || !LOGIN.test(login)) continue;
    if (!permissions.has(login)) {
      let permission = null;
      try {
        permission = permissionFor(login) || null;
      } catch {
        permission = null;
      }
      permissions.set(login, permission);
    }
    const permission = permissions.get(login);
    if (!permission || MAINTAINER_PERMISSIONS.has(permission)) continue;
    credits[number] = login;
  }
  return credits;
}

/** One sentence for release notes, or '' when nobody outside is credited. */
export function contributorCreditLine(credits) {
  const pulls = Object.keys(credits ?? {});
  const logins = [...new Set(Object.values(credits ?? {}))].sort((a, b) => a.localeCompare(b));
  if (logins.length === 0) return '';
  const names = logins.map((login) => `@${login}`);
  const list = names.length === 1
    ? names[0]
    : names.length === 2
      ? `${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
  const noun = pulls.length === 1 ? 'pull request' : 'pull requests';
  return `Thanks to ${list} for their ${noun} in this release.`;
}

function runGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** GitHub lookups through the operator's gh authentication. */
export function ghCreditLookups(repo, { since, run = runGh } = {}) {
  const pullAuthors = new Map();
  try {
    const search = since ? ['--search', `merged:>=${since}`] : [];
    const listed = JSON.parse(run([
      'pr', 'list', '-R', repo, '--state', 'merged', '--limit', '1000', ...search,
      '--json', 'number,author',
    ]) || '[]');
    for (const pull of listed) {
      pullAuthors.set(pull.number, { login: pull.author?.login, isBot: Boolean(pull.author?.is_bot) });
    }
  } catch {
    // No authors means no credits; the caller publishes without them.
  }
  return {
    pullAuthors,
    permissionFor: (login) => run(['api', `repos/${repo}/collaborators/${login}/permission`, '--jq', '.permission']),
  };
}

export function creditsForSubjects(subjects, lookups) {
  const numbers = subjects.map(pullNumberFromSubject).filter((number) => number !== null);
  return resolveContributorCredits(numbers, lookups);
}

// CLI: subjects on stdin, `<pull>\t<login>` lines on stdout.
//   node scripts/lib/contributor-credits.mjs --repo hurttlocker/o8 --since 2026-10-01
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = (name) => {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const repo = option('--repo') ?? 'hurttlocker/o8';
  const since = option('--since');
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const subjects = input.split(/\r?\n/).filter(Boolean);
  const credits = creditsForSubjects(subjects, ghCreditLookups(repo, { since }));
  for (const [number, login] of Object.entries(credits)) process.stdout.write(`${number}\t${login}\n`);
}
