#!/usr/bin/env node
/** Production build reserves generated-output ownership before cache invalidation. */
import { runGeneratedOutputLaunch } from './lib/generated-output-launch.mjs';

process.exitCode = await runGeneratedOutputLaunch('build');
