import { readFileSync } from 'node:fs';
import { runRecordedSession, type RecordedSession } from './lib/ws-parity-session';

async function main() {
  const args = new Map(process.argv.slice(2).map((argument) => {
    const split = argument.indexOf('=');
    return [argument.slice(0, split), argument.slice(split + 1)];
  }));
  const url = args.get('--url');
  const path = args.get('--recording');
  const token = process.env.O8_WS_PARITY_TOKEN;
  if (!url || !path || !token) {
    throw new Error('parity failed: requires --url, --recording, and O8_WS_PARITY_TOKEN');
  }
  const recording = JSON.parse(readFileSync(path, 'utf8')) as RecordedSession;
  if (!Array.isArray(recording.actions)) throw new Error('parity failed: recording requires actions');
  const result = await runRecordedSession(recording, { url, token, fixtureUrl: args.get('--fixture-url') });
  console.log(`parity passed: ${result.envelopes} envelopes, ${result.closes} closes`);
}

void main().catch((error: unknown) => {
  // Network and parse errors can contain URLs or payloads. Only expose our field diagnostics.
  console.error(error instanceof Error && error.message.startsWith('parity failed')
    ? error.message : 'parity failed: recording or transport error');
  process.exitCode = 1;
});
