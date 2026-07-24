'use client';

import {
  IconPlus,
  type MobilePalette,
} from '@/app/mobile/mobile-approvals-shared';
import type { MobileRepoOption } from '@/app/mobile/mobile-chat-repos';
import { MobileRepoPicker } from '@/app/mobile/mobile-repo-picker';
import { useTheme } from '../ThemeContext';

export function FirstConversationCard({
  repoOptions,
  repoPickerPalette,
  selectedRepoPath,
  onSelectRepoPath,
  onCreate,
}: {
  repoOptions: MobileRepoOption[];
  repoPickerPalette?: MobilePalette;
  selectedRepoPath: string | null;
  onSelectRepoPath: (repoPath: string | null) => void;
  onCreate: () => void;
}) {
  const { colors } = useTheme();

  return (
    <div
      style={{
        marginTop: 32,
        marginRight: 'auto',
        marginBottom: 32,
        marginLeft: 'auto',
        maxWidth: 320,
        paddingTop: 16,
        paddingRight: 16,
        paddingBottom: 16,
        paddingLeft: 16,
        borderRadius: 14,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: colors.surfaceBorder,
        background: colors.surface,
        color: colors.textSecondary,
        fontSize: 13,
        lineHeight: 1.5,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: colors.textTertiary,
          marginBottom: 6,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        <IconPlus fill={colors.textTertiary} size={11} />
        <span>No threads</span>
      </div>
      <p
        style={{
          marginTop: 0,
          marginRight: 0,
          marginBottom: 0,
          marginLeft: 0,
        }}
      >
        {repoOptions.length > 0
          ? 'Choose a repository to start your first orchestrator conversation.'
          : 'Add a repository on desktop, then return here to start a conversation.'}
      </p>
      {repoOptions.length > 0 && repoPickerPalette ? (
        <>
          <MobileRepoPicker
            palette={repoPickerPalette}
            repoOptions={repoOptions}
            selectedRepoPath={selectedRepoPath}
            onSelectRepoPath={onSelectRepoPath}
            allowCurrentProject={false}
            alwaysVisible
          />
          <button
            type="button"
            onClick={onCreate}
            disabled={!selectedRepoPath}
            style={{
              width: '100%',
              minHeight: 44,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: selectedRepoPath ? colors.accent : colors.surfaceBorder,
              borderRadius: 14,
              background: selectedRepoPath ? colors.blueGlass : colors.frostStrong,
              color: selectedRepoPath ? colors.accent : colors.textTertiary,
              cursor: selectedRepoPath ? 'pointer' : 'default',
              fontSize: 13,
              fontWeight: 700,
              paddingTop: 10,
              paddingRight: 14,
              paddingBottom: 10,
              paddingLeft: 14,
            }}
          >
            Create conversation
          </button>
        </>
      ) : null}
    </div>
  );
}
