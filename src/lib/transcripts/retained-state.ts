import type { SetStateAction } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { retainTranscriptEntries } from '@/lib/transcripts/store';

export { retainTranscriptEntries };

export function retainedTranscriptReducer(
  previous: MobileTranscriptEntry[],
  update: SetStateAction<MobileTranscriptEntry[]>,
): MobileTranscriptEntry[] {
  return retainTranscriptEntries(typeof update === 'function' ? update(previous) : update);
}
