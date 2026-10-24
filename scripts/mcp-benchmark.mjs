import { writeFileSync } from 'node:fs';
import { rpc } from './speed/mcp.mjs';
import { distribution, evidencePath } from './speed/common.mjs';

async function main() {
  const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const reference = option('reference');
  const candidate = option('candidate');
  const output = option('output');
  const token = process.env.O8_MCP_PARITY_TOKEN;
  if (!reference || !candidate || !output || !token) throw new Error('reference, candidate, output and O8_MCP_PARITY_TOKEN required');
  const names = ['tools/list', 'o8_status', 'get_mission_status', 'o8_task_list', 'o8_list_repos', 'o8_list_projects', 'o8_lease_list'];
  const targets = [{ server: 'TypeScript', base: reference, token }, { server: 'Rust', base: candidate, token }];
  const samples = 100;
  const rows = targets.flatMap(target => names.map(name => ({ server: target.server, name, values: [] })));
  for (let sample = -10; sample < samples; sample += 1) {
    for (const name of names) {
      for (const target of sample % 2 ? [...targets].reverse() : targets) {
        const result = name === 'tools/list' ? await rpc(target, name) : await rpc(target, 'tools/call', { name, arguments: {} });
        if (sample >= 0) rows.find(row => row.server === target.server && row.name === name).values.push(result.ms);
      }
    }
  }
  const results = rows.map(({ values, ...row }) => ({ ...row, ...distribution(values) }));
  writeFileSync(evidencePath(output), `${JSON.stringify({ warmups: 10, samples, results }, null, 2)}\n`);
  console.log('MCP benchmark passed: 7 operations, 100 samples per server');
}
main().catch(error => {
  console.error(`MCP benchmark failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
