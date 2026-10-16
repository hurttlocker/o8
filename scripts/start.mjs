#!/usr/bin/env node
/** Production Next consumes generated output under the same producer exclusion. */
import { runGeneratedOutputLaunch } from './lib/generated-output-launch.mjs';

process.exitCode = await runGeneratedOutputLaunch('start', ['-p', process.env.PORT || '3001']);
