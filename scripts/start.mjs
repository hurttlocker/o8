#!/usr/bin/env node
/**
 * Serve a production Next build (#1744). Replaces
 * `sh -c 'next start -p "${PORT:-3001}"'`, which cmd.exe cannot run.
 *
 * `${PORT:-3001}` falls back when PORT is unset OR empty, which is exactly
 * what `||` does for the empty string here.
 */

import { runAndExit } from './run-lib.mjs';

runAndExit('next', ['start', '-p', process.env.PORT || '3001']);
