import { readFileSync } from 'node:fs';
import { replayNextRequests, type RecordedNextRequest } from './lib/next-http-parity';

async function main() {
  const option = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const reference = option('reference');
  const candidate = option('candidate');
  const recording = option('recording');
  const token = process.env.O8_NEXT_API_TOKEN;
  if (!reference || !candidate || !recording || !token) throw new Error('Pass reference, candidate, recording and O8_NEXT_API_TOKEN');
  const bytes = readFileSync(recording, 'utf8').replaceAll('$REPO', encodeURIComponent(option('fixture-repo') ?? ''));
  const records = JSON.parse(bytes) as RecordedNextRequest[];
  const count = await replayNextRequests(reference, candidate, token, records);
  console.log(`o8 next HTTP parity passed: ${count} requests`);
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'HTTP parity failed'); process.exitCode = 1; });
