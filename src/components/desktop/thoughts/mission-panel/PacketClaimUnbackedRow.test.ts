import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ClaimUnbacked } from '@/lib/lane/report-claim-check';
import { PacketClaimUnbackedRowView } from './PacketClaimUnbackedRow';

const flags = { zeroWidth: false, bidiControl: false, mixedScript: false, crlfMixed: false };
const claim: ClaimUnbacked = {
  receiptId: 'jdg_claim_row',
  packetId: 'pkt-row',
  claims: ['tests'],
  answers: { claimsTestsRun: 0.94, evidenceShowsTestsRun: 0.03, claimsFilesNotInDiff: 0.06, claimsVerifiedRealPath: 0.2 },
  verificationOutputPresent: false,
  reportFlags: flags,
  outputFlags: null,
  reportTruncated: false,
  outputTruncated: false,
  changedFileCount: 1,
  diffFingerprint: 'fp',
  reportFingerprint: 'rfp',
};

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('packet card unbacked-claim row', () => {
  it('names the unbacked claim and the receipt id as an advisory row', () => {
    const markup = renderToStaticMarkup(createElement(PacketClaimUnbackedRowView, { claim }));
    expect(markup).toContain('data-o8-claim-unbacked-row');
    expect(text(markup)).toContain('Report claim not backed: tests');
    expect(text(markup)).toContain('jdg_claim_row');
    expect(text(markup)).toContain('Advisory');
    expect(markup).not.toContain('class=');
  });

  it('names both kinds when the report also describes files outside the diff', () => {
    const markup = renderToStaticMarkup(createElement(PacketClaimUnbackedRowView, { claim: { ...claim, claims: ['tests', 'files'], verificationOutputPresent: true } }));
    expect(text(markup)).toContain('Report claim not backed: tests, files not in the diff');
    expect(text(markup)).not.toContain('no command output recorded');
  });
});
