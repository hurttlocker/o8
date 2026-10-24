import { readFileSync } from 'node:fs';
import { replayMcp, type RecordedMcpRequest } from './lib/mcp-parity';

async function main() {
  const option = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const reference = option('reference');
  const candidate = option('candidate');
  const path = option('recording');
  const token = process.env.O8_MCP_PARITY_TOKEN;
  if (!reference || !candidate || !path || !token) throw new Error('reference, candidate, recording and O8_MCP_PARITY_TOKEN required');
  const requests = JSON.parse(readFileSync(path, 'utf8')) as RecordedMcpRequest[];
  const count = await replayMcp(reference, candidate, token, requests);
  console.log(`MCP parity passed: ${count} recorded requests`);
}
main().catch((error: unknown) => {
  console.error(`MCP parity failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
