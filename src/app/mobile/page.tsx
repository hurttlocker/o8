import { MobileRemoteShell } from '@/components/mobile-remote-shell';
import { getOwnedCodexReviewPacket } from '@/lib/codex/owned';
import { getMobileInboxSnapshot } from '@/lib/mobile/openclaw';
import { getSessionTranscript } from '@/lib/openclaw/chat';
import { getReviewFileDetail } from '@/lib/review/workspace';

export const dynamic = 'force-dynamic';

export default async function MobilePage() {
  const initialSnapshot = await getMobileInboxSnapshot();
  const initialSession = initialSnapshot.sessions.find((session) => session.sessionKey === initialSnapshot.primarySessionKey)
    ?? initialSnapshot.sessions.find((session) => session.isCurrentSession)
    ?? initialSnapshot.sessions[0];
  const initialSessionKey = initialSession?.sessionKey;
  const initialOwnedReviewPacket = initialSessionKey && initialSession?.runtime === 'codex' && initialSession.runtimeSurface?.ownership === 'owned'
    ? await getOwnedCodexReviewPacket(initialSessionKey).catch(() => null)
    : null;
  const initialReviewPath = initialOwnedReviewPacket?.changedFiles[0]?.path
    ?? initialSnapshot.review?.changedFiles[0]?.path;

  const [initialTranscript, initialReviewFile] = await Promise.all([
    initialSessionKey
      ? getSessionTranscript(initialSessionKey, 18)
          .then((transcript) => ({ sessionKey: initialSessionKey, transcript }))
          .catch(() => undefined)
      : Promise.resolve(undefined),
    initialReviewPath
      ? getReviewFileDetail(initialReviewPath).catch(() => null)
      : Promise.resolve(null),
  ]);

  return (
    <MobileRemoteShell
      initialSnapshot={initialSnapshot}
      initialTranscript={initialTranscript}
      initialReviewFile={initialReviewFile}
      initialOwnedReviewPacket={initialOwnedReviewPacket}
    />
  );
}
