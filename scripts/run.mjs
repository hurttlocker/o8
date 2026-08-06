#!/usr/bin/env node
/**
 * Shell-neutral stand-in for a POSIX `VAR=value command args` npm script (#1744).
 *
 *   node scripts/run.mjs KEY=VALUE [KEY=VALUE ...] -- <command> [args...]
 *
 * Assignments are layered on top of the inherited environment, the child
 * inherits stdio, and its exit code is propagated — the same contract the
 * inline prefix had, minus the requirement for a POSIX shell.
 */

import { parseEnvPrefixArgv, runAndExit } from './run-lib.mjs';

const { assignments, command, args } = parseEnvPrefixArgv(process.argv.slice(2));

if (!command) {
  process.stderr.write('usage: node scripts/run.mjs KEY=VALUE ... -- <command> [args...]\n');
  process.exit(1);
}

runAndExit(command, args, { ...process.env, ...assignments });
