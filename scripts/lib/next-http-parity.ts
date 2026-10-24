export interface RecordedNextRequest {
  name: string;
  path: string;
  credential?: 'absent' | 'invalid' | 'read-only';
}

export async function sendNextRequest(origin: string, token: string, record: RecordedNextRequest) {
  const credential = record.credential === 'absent' ? null
    : record.credential === 'invalid' ? 'fixture-invalid'
      : record.credential === 'read-only' ? 'o8ro_fixture' : token;
  const response = await fetch(new URL(record.path, origin), {
    headers: credential ? { authorization: `Bearer ${credential}` } : {}, redirect: 'manual',
  });
  return { status: response.status, body: await response.json() as unknown };
}

/** Compare the complete JSON body, including absent fields, pagination and errors. */
export async function replayNextRequests(reference: string, candidate: string, token: string, records: RecordedNextRequest[]) {
  const { isDeepStrictEqual } = await import('node:util');
  for (const record of records) {
    const expected = await sendNextRequest(reference, token, record);
    const actual = await sendNextRequest(candidate, token, record);
    if (!isDeepStrictEqual(expected, actual)) throw new Error(`HTTP parity mismatch: ${record.name}`);
  }
  return records.length;
}
