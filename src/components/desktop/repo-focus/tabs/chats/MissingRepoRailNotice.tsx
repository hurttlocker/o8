'use client';

import { REPO_FOCUS_FONT } from '../../utils';

export function MissingRepoRailNotice({ summary }: { summary: string }) {
  return (
    <div
      style={{
        paddingTop: 3,
        paddingRight: 12,
        paddingBottom: 7,
        paddingLeft: 29,
        fontSize: 11,
        lineHeight: '15px',
        fontWeight: 300,
        color: 'var(--t-danger)',
        fontFamily: REPO_FOCUS_FONT,
        overflowWrap: 'anywhere',
      }}
    >
      {summary}
    </div>
  );
}
