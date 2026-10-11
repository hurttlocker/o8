#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const mode = process.env.O8_CLAUDE_CAPACITY_TEST_MODE;
const audit = process.env.O8_CLAUDE_CAPACITY_TEST_AUDIT;
if (audit) appendFileSync(audit, `${JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })}\n`);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (audit) appendFileSync(audit, `${JSON.stringify(row)}\n`);
  if (row.type !== 'control_request') process.exit(3);
  if (mode === 'timeout') return;
  const payload = row.request.subtype === 'initialize' ? {} : {
    rate_limits_available: mode !== 'unsupported',
    rate_limits: mode === 'unsupported' ? null : {
      five_hour: { utilization: mode === 'malformed' ? 110 : 15, resets_at: '2026-10-09T01:50:00Z' },
      seven_day: { utilization: 59, resets_at: '2026-10-14T12:00:00Z' },
      model_scoped: [{ display_name: 'Example model', utilization: 22, resets_at: null }],
    },
    subscription_type: 'private-plan', account_email: 'private@example.invalid',
  };
  // Split writes exercise the actual stream buffer and request correlation.
  process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'unrelated', response: {} } })}\n`);
  const text = `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: row.request_id, response: payload } })}\n`;
  process.stdout.write(text.slice(0, 17));
  setTimeout(() => process.stdout.write(text.slice(17)), 5);
});
