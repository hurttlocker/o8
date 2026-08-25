#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performShipPreflight } from './lib/ship-preflight.mjs';

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const receipt = performShipPreflight({ root, version: packageJson.version });
console.log(`[release] preflight passed for ${receipt.tag} at ${receipt.head.slice(0, 12)} (${receipt.availableGiB.toFixed(1)} GiB free)`);
