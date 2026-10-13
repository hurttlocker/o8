#!/usr/bin/env node
import { runGeneratedOutputLaunch } from './lib/generated-output-launch.mjs';
import { prebuildEnvironment } from './lib/release-build-profile.mjs';

process.exitCode = await runGeneratedOutputLaunch('prebuild', [], prebuildEnvironment(process.cwd()));
