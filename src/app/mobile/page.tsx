import { MobileRemoteShell } from '@/components/mobile-remote-shell';
import { getMobileInboxSnapshot } from '@/lib/mobile/openclaw';
import { getSessionTranscript } from '@/lib/openclaw/chat';
import { getReviewFileDetail } from '@/lib/review/workspace';

export const dynamic = 'force-dynamic';

export default async function MobilePage() {
  const initialSnapshot = await getMobileInboxSnapshot();
  const initialSessionKey = initialSnapshot.primarySessionKey
    ?? initialSnapshot.sessions.find((session) => session.isCurrentSession)?.sessionKey
    ?? initialSnapshot.sessions[0]?.sessionKey;
  const initialReviewPath = initialSnapshot.review?.changedFiles[0]?.path;

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
    />
  );
}
