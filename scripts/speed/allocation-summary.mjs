#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { root } from './common.mjs';

export async function allocationSummary(file) {
  const canonical = fs.realpathSync(file);
  if (!canonical.startsWith(root + path.sep)) throw new Error('Analyze only owned allocation evidence');
  const bytes = { urlpatternRegex: 0, shellScopeRegex: 0, otherRegex: 0, urlpatternOther: 0 };
  const calls = { ...bytes };
  let allocationRecords = 0;
  const lines = createInterface({ input: fs.createReadStream(canonical), crlfDelay: Infinity });
  for await (const line of lines) {
    const match = line.match(/^(\d+) calls? for (\d+) bytes:/);
    if (!match) continue;
    allocationRecords++;
    const regex = /regex::|regex_automata::|regex_syntax::/.test(line);
    const pattern = line.includes('urlpattern::') || line.includes('urlpattern..');
    const key = regex ? pattern ? 'urlpatternRegex' : line.includes('open_scope') ? 'shellScopeRegex' : 'otherRegex' : pattern ? 'urlpatternOther' : null;
    if (key) { calls[key] += Number(match[1]); bytes[key] += Number(match[2]); }
  }
  return { schema: 'o8/speed-allocation-owners/v1', allocationRecords, bytes, calls,
    limits: 'Live stack-attributed allocation bytes, not dominator sizes or RSS. Unrelated VM/file mappings are deliberately not totaled. Logging perturbs the diagnostic process.' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) process.stdout.write(JSON.stringify(await allocationSummary(process.argv[2]), null, 2) + '\n');
