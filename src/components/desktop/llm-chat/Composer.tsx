/* eslint-disable @next/next/no-img-element -- composer previews are transient local data URIs */
import { memo } from 'react';
import type React from 'react';
import { AlertCircle, ArrowUp, Eye, GitPullRequest, Globe, Lightbulb, Pencil, Plus, Search, Sparkles, Square, Terminal, Wrench, X } from '../lucide-shims';

import type { LinkedIssueRef } from '../IssueLinkPicker';
import { ApprovalBanner } from './ApprovalBanner';
import { ApplyToFileModal } from './ApplyToFileModal';
import { ModelPicker } from './ModelPicker';
import { SLASH_COMMANDS, THEME_ACCENT, THEME_ACCENT_BORDER, THEME_ACCENT_RING, THEME_ACCENT_SOFT, THEME_BG_CARD, THEME_PANEL_GLASS, type AttachedImage, type FileSuggestion, type ModelOption, type PendingApprovalState, type QueuedContextCard, type SlashCommandOption } from './shared';

function renderSlashCommandIcon(icon: SlashCommandOption['icon']) {
  if (icon === 'globe') return <Globe size={16} />;
  if (icon === 'search' || icon === 'file') return <Search size={16} />;
  if (icon === 'brain' || icon === 'test') return <Sparkles size={16} />;
  if (icon === 'review') return <Eye size={16} />;
  if (icon === 'idea') return <Lightbulb size={16} />;
  if (icon === 'fix') return <Wrench size={16} />;
  if (icon === 'issue') return <AlertCircle size={16} />;
  if (icon === 'pr') return <GitPullRequest size={16} />;
  return <Terminal size={16} />;
}

function ComposerBase({
  applyFileIndex,
  applyFileSuggestions,
  applyModal,
  applyPath,
  applyStatus,
  attachedFiles,
  attachedImages,
  editedCommand,
  filePickerIndex,
  fileSuggestions,
  input,
  inputRef,
  isStreaming,
  linkedIssue,
  model,
  models,
  pendingApproval,
  queuedContextCards,
  showFilePicker,
  showSlashPicker,
  slashIndex,
  onApply,
  onApplyFileIndexChange,
  onApplyModalClose,
  onApplyPathChange,
  onApprovePending,
  onAttachedFileRemove,
  onAttachedImageRemove,
  onDenyPending,
  onEditedCommandChange,
  onFilePickerIndexChange,
  onFileSelect,
  onHandleInputChange,
  onInputDragOver,
  onInputDrop,
  onInputKeyDown,
  onInputPaste,
  onIssuePickerOpen,
  onLinkIssueClear,
  onModelSelect,
  onQueuedContextRemove,
  onSend,
  onSlashIndexChange,
  onStop,
  onUploadFiles,
  searchApplyFiles,
  permissionMode = 'full',
  onTogglePermission,
}: {
  applyFileIndex: number;
  applyFileSuggestions: Array<{ path: string }>;
  applyModal: { code: string; language: string } | null;
  applyPath: string;
  applyStatus: 'idle' | 'applying' | 'done' | 'error';
  attachedFiles: string[];
  attachedImages: AttachedImage[];
  editedCommand: string;
  filePickerIndex: number;
  fileSuggestions: FileSuggestion[];
  input: string;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  isStreaming: boolean;
  linkedIssue?: LinkedIssueRef | null;
  model: ModelOption;
  pendingApproval: PendingApprovalState | null;
  queuedContextCards: QueuedContextCard[];
  showFilePicker: boolean;
  showSlashPicker: boolean;
  slashIndex: number;
  onApply: () => void;
  onApplyFileIndexChange: (index: number) => void;
  onApplyModalClose: () => void;
  onApplyPathChange: (value: string) => void;
  onApprovePending: () => void;
  onAttachedFileRemove: (path: string) => void;
  onAttachedImageRemove: (index: number) => void;
  onDenyPending: () => void;
  onEditedCommandChange: (value: string) => void;
  onFilePickerIndexChange: (index: number) => void;
  onFileSelect: (path: string) => void;
  onHandleInputChange: (value: string) => void;
  onInputDragOver: (event: React.DragEvent) => void;
  onInputDrop: (event: React.DragEvent) => void;
  onInputKeyDown: (event: React.KeyboardEvent) => void;
  onInputPaste: (event: React.ClipboardEvent) => void;
  onIssuePickerOpen: () => void;
  onLinkIssueClear: () => void;
  models: ModelOption[];
  onModelSelect: (model: ModelOption) => void;
  onQueuedContextRemove: (id: string) => void;
  onSend: () => void;
  onSlashIndexChange: (index: number) => void;
  onStop: () => void;
  onUploadFiles: (files: FileList) => void;
  searchApplyFiles: (query: string) => void;
  permissionMode?: 'full' | 'plan';
  onTogglePermission?: () => void;
}) {
  return (
    <>
      <ApprovalBanner
        editedCommand={editedCommand}
        onApprovePending={onApprovePending}
        onDenyPending={onDenyPending}
        onEditedCommandChange={onEditedCommandChange}
        pendingApproval={pendingApproval}
      />

      <div style={{ paddingTop: 12, paddingRight: 24, paddingBottom: 16, paddingLeft: 24, borderTop: '1px solid var(--t-divider)', position: 'relative' }}>
        {attachedImages.length > 0 ? (
          <div style={{ display: 'flex', gap: 8, maxWidth: 720, marginLeft: 'auto', marginRight: 'auto', marginBottom: 8, overflowX: 'auto' }}>
            {attachedImages.map((image, index) => (
              <div key={`${image.name}-${index}`} style={{ position: 'relative', flexShrink: 0 }}>
                <img src={image.dataUri} alt={image.name} style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: '1px solid #e2e8f0' }} />
                <button type="button" onClick={() => onAttachedImageRemove(index)} style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', border: '1px solid #e2e8f0', background: '#ffffff', color: '#94a3b8', fontSize: 11, lineHeight: '16px', textAlign: 'center', cursor: 'pointer', paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>x</button>
              </div>
            ))}
          </div>
        ) : null}

        {attachedFiles.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxWidth: 720, marginLeft: 'auto', marginRight: 'auto', marginBottom: 8 }}>
            {attachedFiles.map((filePath) => (
              <span key={filePath} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, paddingTop: 3, paddingRight: 6, paddingBottom: 3, paddingLeft: 8, background: '#eff6ff', color: '#3b82f6', fontSize: 11, fontFamily: 'ui-monospace, monospace', borderRadius: 6, border: '1px solid #bfdbfe' }}>
                {filePath.split('/').pop()}
                <button type="button" onClick={() => onAttachedFileRemove(filePath)} style={{ border: 'none', background: 'none', color: '#93c5fd', cursor: 'pointer', paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, lineHeight: 1 }}>x</button>
              </span>
            ))}
          </div>
        ) : null}

        {showFilePicker && fileSuggestions.length > 0 ? (
          <div style={{ position: 'absolute', bottom: '100%', left: 24, right: 24, maxWidth: 720, marginLeft: 'auto', marginRight: 'auto', marginBottom: 4, background: THEME_PANEL_GLASS, border: '1px solid var(--t-panel-border)', borderRadius: 10, boxShadow: 'var(--t-panel-shadow)', overflow: 'hidden', maxHeight: 200, overflowY: 'auto', zIndex: 100 }}>
            <div style={{ paddingTop: 6, paddingRight: 10, paddingBottom: 4, paddingLeft: 10, fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Files</div>
            {fileSuggestions.map((file, index) => (
              <button key={file.path} type="button" onClick={() => onFileSelect(file.path)} style={{ display: 'block', width: '100%', paddingTop: 6, paddingRight: 12, paddingBottom: 6, paddingLeft: 12, border: 'none', background: index === filePickerIndex ? THEME_ACCENT_SOFT : 'transparent', color: 'var(--t-text)', fontSize: 12, fontFamily: 'ui-monospace, monospace', textAlign: 'left', cursor: 'pointer', transition: 'background 60ms' }} onMouseEnter={() => onFilePickerIndexChange(index)}>
                {file.path}
              </button>
            ))}
          </div>
        ) : null}

        {showSlashPicker ? (
          <div style={{ position: 'absolute', bottom: '100%', left: 24, right: 24, maxWidth: 720, marginLeft: 'auto', marginRight: 'auto', marginBottom: 4, background: THEME_PANEL_GLASS, border: '1px solid var(--t-panel-border)', borderRadius: 12, boxShadow: 'var(--t-panel-shadow)', overflow: 'hidden', zIndex: 100, animation: 'llmFadeIn 150ms ease-out' }}>
            <div style={{ paddingTop: 8, paddingRight: 12, paddingBottom: 4, paddingLeft: 12, fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Commands</div>
            {SLASH_COMMANDS.filter((command) => command.command.startsWith(input.toLowerCase())).map((command, index) => (
              <button key={command.command} type="button" onClick={() => { onHandleInputChange(command.prefix); onSlashIndexChange(0); inputRef.current?.focus(); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, border: 'none', background: index === slashIndex ? THEME_ACCENT_SOFT : 'transparent', textAlign: 'left', cursor: 'pointer', transition: 'background 60ms' }} onMouseEnter={() => onSlashIndexChange(index)}>
                <span style={{ color: 'var(--t-text-muted)', display: 'inline-flex', alignItems: 'center' }}>{renderSlashCommandIcon(command.icon)}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text)' }}>{command.command} <span style={{ fontWeight: 400, color: '#64748b' }}>{command.label}</span></div>
                  <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{command.description}</div>
                </div>
              </button>
            ))}
          </div>
        ) : null}

        <div style={{ maxWidth: 720, marginLeft: 'auto', marginRight: 'auto', border: '1px solid var(--t-panel-border)', borderRadius: 18, background: 'var(--t-chat-surface-bg, #ffffff)', transition: 'border-color 200ms, box-shadow 200ms', overflow: 'hidden' }} onFocus={(event) => { event.currentTarget.style.borderColor = THEME_ACCENT; event.currentTarget.style.boxShadow = `0 0 0 3px ${THEME_ACCENT_RING}`; }} onBlur={(event) => { event.currentTarget.style.borderColor = 'var(--t-panel-border)'; event.currentTarget.style.boxShadow = 'none'; }}>
          {queuedContextCards.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 14, paddingRight: 14, paddingBottom: 0, paddingLeft: 14, borderBottom: '1px solid var(--t-divider-subtle)' }}>
              {queuedContextCards.map((card) => (
                <div key={card.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, paddingTop: 8, paddingRight: 10, paddingBottom: 8, paddingLeft: 10, borderRadius: 12, border: '1px solid var(--t-panel-border)', background: THEME_BG_CARD }}>
                  {card.previewImageDataUri ? (
                    <img src={card.previewImageDataUri} alt="Captured design region" style={{ width: 72, height: 54, borderRadius: 9, border: '1px solid var(--t-border)', objectFit: 'cover', flexShrink: 0 }} />
                  ) : (
                    <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 9, background: THEME_ACCENT_SOFT, color: THEME_ACCENT, flexShrink: 0 }}><Pencil size={14} /></div>
                  )}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: THEME_ACCENT }}>Staged Context</div>
                    <div style={{ marginTop: 3, fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>{card.title}</div>
                    {card.meta.length > 0 ? <div style={{ marginTop: 3, display: 'flex', gap: 7, flexWrap: 'wrap', fontSize: 10, color: 'var(--t-text-muted)' }}>{card.meta.slice(0, 2).map((entry) => <span key={entry}>{entry}</span>)}</div> : null}
                    {card.preview ? <div style={{ marginTop: 5, fontSize: 11, lineHeight: 1.45, color: 'var(--t-text-secondary)' }}>{card.preview}</div> : null}
                  </div>
                  <button type="button" onClick={() => onQueuedContextRemove(card.id)} aria-label="Remove staged context" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 9, border: '1px solid var(--t-panel-border)', background: 'transparent', color: 'var(--t-text-faint)', cursor: 'pointer', flexShrink: 0 }}><X size={14} /></button>
                </div>
              ))}
            </div>
          ) : null}

          <div style={{ paddingTop: 14, paddingRight: 18, paddingBottom: 8, paddingLeft: 18 }}>
            <textarea name="llmChatMessage" aria-label={`Message ${model.label}`} ref={inputRef} value={input} onChange={(event) => onHandleInputChange(event.target.value)} onKeyDown={onInputKeyDown} onPaste={onInputPaste} onDrop={onInputDrop} onDragOver={onInputDragOver} placeholder={`Message ${model.label}...`} rows={1} style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', color: 'var(--t-text)', fontSize: 14, fontFamily: 'var(--font-sans-system)', lineHeight: '1.5', resize: 'none', minHeight: 24, maxHeight: 200, boxSizing: 'border-box' }} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 4, paddingRight: 10, paddingBottom: 10, paddingLeft: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <label title="Attach file or image" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer', transition: 'color 150ms, background 150ms' }} onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--t-text-secondary)'; event.currentTarget.style.background = THEME_BG_CARD; }} onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--t-text-muted)'; event.currentTarget.style.background = 'transparent'; }}>
                <Plus size={16} />
                <input name="llmChatAttachments" aria-label="Attach files" type="file" accept="image/*,.txt,.md,.ts,.tsx,.js,.jsx,.py,.json,.yaml,.yml,.toml,.css,.html" multiple style={{ display: 'none' }} onChange={(event) => { const files = event.target.files; if (!files) return; onUploadFiles(files); event.target.value = ''; }} />
              </label>
              <span style={{ fontSize: 10, color: 'var(--t-text-faint)', fontFamily: 'var(--font-sans-system)' }}>@file | /cmds</span>
              <button type="button" onClick={onIssuePickerOpen} title={linkedIssue ? linkedIssue.title : 'Link a GitHub issue to this chat'} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 28, paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 10, borderRadius: 999, border: linkedIssue ? `1px solid ${THEME_ACCENT_BORDER}` : '1px solid var(--t-panel-border)', background: linkedIssue ? THEME_ACCENT_SOFT : THEME_BG_CARD, color: linkedIssue ? THEME_ACCENT : 'var(--t-text-secondary)', cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-sans-system)', whiteSpace: 'nowrap' }}>
                <AlertCircle size={13} />
                {linkedIssue ? `Issue #${linkedIssue.number}` : 'Link issue'}
              </button>
              {linkedIssue ? <button type="button" onClick={onLinkIssueClear} title="Clear linked issue" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer' }}><X size={14} /></button> : null}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {model.provider === 'operator' && onTogglePermission ? (
                <button
                  type="button"
                  onClick={onTogglePermission}
                  title={permissionMode === 'full' ? 'Code mode — can edit files & run commands. Click to switch to Plan.' : 'Plan mode — read-only. Click to switch to Code.'}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    minHeight: 28,
                    paddingTop: 0,
                    paddingRight: 10,
                    paddingBottom: 0,
                    paddingLeft: 9,
                    borderRadius: 999,
                    border: '1px solid var(--t-panel-border)',
                    background: permissionMode === 'plan' ? 'var(--t-bg-card)' : THEME_ACCENT_SOFT,
                    color: permissionMode === 'plan' ? 'var(--t-text-secondary)' : THEME_ACCENT,
                    cursor: 'pointer',
                    fontSize: 11,
                    fontWeight: 700,
                    fontFamily: 'var(--font-sans-system)',
                    letterSpacing: '-0.005em',
                    transition: 'background 150ms, color 150ms, border-color 150ms',
                  }}
                >
                  {permissionMode === 'plan' ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                    </svg>
                  )}
                  {permissionMode === 'plan' ? 'Plan' : 'Code'}
                </button>
              ) : null}
              <ModelPicker selected={model} models={models} onSelect={onModelSelect} disabled={isStreaming} />
              {isStreaming ? (
                <button type="button" onClick={onStop} title="Stop generating (Esc)" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, border: 'none', borderRadius: 10, background: '#ef4444', color: '#ffffff', cursor: 'pointer', flexShrink: 0, transition: 'background 150ms' }} onMouseEnter={(event) => { event.currentTarget.style.background = '#dc2626'; }} onMouseLeave={(event) => { event.currentTarget.style.background = '#ef4444'; }}>
                  <Square size={14} />
                </button>
              ) : (
                <button type="button" data-send-btn="true" onClick={onSend} disabled={!input.trim() && queuedContextCards.length === 0} title="Send message (Enter)" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, border: 'none', borderRadius: 10, background: input.trim() || queuedContextCards.length > 0 ? THEME_ACCENT : 'var(--t-divider-strong)', color: input.trim() || queuedContextCards.length > 0 ? '#ffffff' : 'var(--t-text-faint)', cursor: input.trim() || queuedContextCards.length > 0 ? 'pointer' : 'default', flexShrink: 0, transition: 'all 150ms' }}>
                  <ArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <ApplyToFileModal
        applyFileIndex={applyFileIndex}
        applyFileSuggestions={applyFileSuggestions}
        applyModal={applyModal}
        applyPath={applyPath}
        applyStatus={applyStatus}
        onApply={onApply}
        onApplyFileIndexChange={onApplyFileIndexChange}
        onApplyModalClose={onApplyModalClose}
        onApplyPathChange={onApplyPathChange}
        searchApplyFiles={searchApplyFiles}
      />
    </>
  );
}

export const Composer = memo(ComposerBase);
