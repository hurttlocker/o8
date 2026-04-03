'use client';

import type { CSSProperties, ReactElement } from 'react';
import ArrowLeftPaths from '@phosphor-icons/react/dist/defs/ArrowLeft.es.js';
import ArrowClockwisePaths from '@phosphor-icons/react/dist/defs/ArrowClockwise.es.js';
import CaretDownPaths from '@phosphor-icons/react/dist/defs/CaretDown.es.js';
import CaretRightPaths from '@phosphor-icons/react/dist/defs/CaretRight.es.js';
import ChatCircleDotsPaths from '@phosphor-icons/react/dist/defs/ChatCircleDots.es.js';
import CheckCirclePaths from '@phosphor-icons/react/dist/defs/CheckCircle.es.js';
import GearPaths from '@phosphor-icons/react/dist/defs/Gear.es.js';
import ListPaths from '@phosphor-icons/react/dist/defs/List.es.js';
import MoonStarsPaths from '@phosphor-icons/react/dist/defs/MoonStars.es.js';
import PaperPlaneTiltPaths from '@phosphor-icons/react/dist/defs/PaperPlaneTilt.es.js';
import PencilSimplePaths from '@phosphor-icons/react/dist/defs/PencilSimple.es.js';
import ShieldPaths from '@phosphor-icons/react/dist/defs/Shield.es.js';
import SpeakerHighPaths from '@phosphor-icons/react/dist/defs/SpeakerHigh.es.js';
import StarPaths from '@phosphor-icons/react/dist/defs/Star.es.js';
import StopCirclePaths from '@phosphor-icons/react/dist/defs/StopCircle.es.js';
import SunDimPaths from '@phosphor-icons/react/dist/defs/SunDim.es.js';
import TrashPaths from '@phosphor-icons/react/dist/defs/Trash.es.js';

export type MobileView = 'approvals' | 'chat' | 'settings';

export interface ApprovalItem {
  id: string;
  title: string;
  description?: string;
  summary?: string;
  risk: 'low' | 'medium' | 'high';
  source?: 'llm-chat' | 'runtime' | 'test';
  toolName?: string;
  sessionKey?: string;
  status: string;
  createdAt: number;
  metadata?: Record<string, string>;
  continuation?: { kind: 'llm-chat' | 'runtime' | 'lane' };
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatHistoryRecord {
  tabId: string;
  title: string;
  lastMessage: string;
  updatedAt: string;
  model?: string;
  starred?: boolean;
}

export interface ModelOption {
  id: string;
  label: string;
  provider: 'google' | 'anthropic' | 'openai';
  description: string;
}

export interface MobilePalette {
  isDark: boolean;
  rootBackground: string;
  rootText: string;
  mutedText: string;
  subduedText: string;
  sidebarBackground: string;
  overlayBackground: string;
  panelBackground: string;
  panelElevated: string;
  cardBackground: string;
  cardBorder: string;
  menuBackground: string;
  accent: string;
  accentSoft: string;
  accentBorder: string;
  success: string;
  successSoft: string;
  successBorder: string;
  danger: string;
  dangerSoft: string;
  dangerBorder: string;
  warning: string;
  warningSoft: string;
  inputBackground: string;
  inputBorder: string;
  composerBackground: string;
  userBubble: string;
  iconFill: IconFill;
  inverseIconFill: IconFill;
  shadow: string;
}

type IconWeight = 'thin' | 'regular';
type IconDefs = ReadonlyMap<string, ReactElement>;
export type IconFill = '#ffffff' | '#1a1a2e';

export const RISK_COLORS: Record<string, string> = {
  high: '#ef4444',
  medium: '#f59e0b',
  low: '#22c55e',
};

export const AVAILABLE_MODELS: ModelOption[] = [
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', provider: 'google', description: 'Latest flagship' },
  { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro', provider: 'google', description: 'Previous gen flagship' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', provider: 'google', description: 'Fast and capable' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'google', description: 'Stable general-purpose model' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'google', description: 'Faster and lighter' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', provider: 'google', description: 'Lowest cost Google option' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'anthropic', description: 'Fast and high quality' },
  { id: 'gpt-5.4', label: 'GPT-5.4', provider: 'openai', description: 'Latest OpenAI model' },
];

export const DEFAULT_MOBILE_CHAT_MODEL = 'gemini-3.1-pro-preview';
export const MOBILE_CHAT_STORAGE_KEY = 'o8-mobile-chat-tab';
export const MOBILE_CHAT_MODEL_STORAGE_KEY = 'o8-mobile-chat-model';
export const POLL_INTERVAL = 5_000;
export const SIDEBAR_WIDTH = 280;
export const MAX_RECENT_CONVERSATIONS = 10;
export const CHAT_TITLE_MAX_LENGTH = 50;
export const SIDEBAR_TITLE_MAX_LENGTH = 40;

function renderPhosphorIcon(
  defs: IconDefs,
  size: number,
  fill: IconFill,
  style?: CSSProperties,
  weight: IconWeight = 'regular',
) {
  const fragment = defs.get(weight) ?? defs.get('regular') ?? null;
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill={fill} style={style}>
      {fragment}
    </svg>
  );
}

interface MobileIconProps {
  fill: IconFill;
  size?: number;
  style?: CSSProperties;
  weight?: IconWeight;
}

export function IconArrowLeft({ fill, size = 18, style, weight = 'regular' }: MobileIconProps) {
  return renderPhosphorIcon(ArrowLeftPaths as IconDefs, size, fill, style, weight);
}

export function IconCaretDown({ fill, size = 18, style, weight = 'regular' }: MobileIconProps) {
  return renderPhosphorIcon(CaretDownPaths as IconDefs, size, fill, style, weight);
}

export function IconCaretRight({ fill, size = 16, style, weight = 'regular' }: MobileIconProps) {
  return renderPhosphorIcon(CaretRightPaths as IconDefs, size, fill, style, weight);
}

export function IconChat({ fill, size = 20, style, weight = 'regular' }: MobileIconProps) {
  return renderPhosphorIcon(ChatCircleDotsPaths as IconDefs, size, fill, style, weight);
}

export function IconCheck({ fill, size = 48, style, weight = 'regular' }: MobileIconProps) {
  return renderPhosphorIcon(CheckCirclePaths as IconDefs, size, fill, style, weight);
}

export function IconGear({ fill, size = 20, style, weight = 'regular' }: MobileIconProps) {
  return renderPhosphorIcon(GearPaths as IconDefs, size, fill, style, weight);
}

export function IconHamburger({ fill, size = 22, style, weight = 'regular' }: MobileIconProps) {
  return renderPhosphorIcon(ListPaths as IconDefs, size, fill, style, weight);
}

export function IconMoon({ fill, size = 18, style, weight = 'regular' }: MobileIconProps) {
  return renderPhosphorIcon(MoonStarsPaths as IconDefs, size, fill, style, weight);
}

export function IconRefresh({ fill, size = 18, style }: MobileIconProps) {
  return renderPhosphorIcon(ArrowClockwisePaths as IconDefs, size, fill, style, 'thin');
}

export function IconSend({ fill, size = 16, style, weight = 'regular' }: MobileIconProps) {
  return renderPhosphorIcon(PaperPlaneTiltPaths as IconDefs, size, fill, style, weight);
}

export function IconShield({ fill, size = 20, style, weight = 'regular' }: MobileIconProps) {
  return renderPhosphorIcon(ShieldPaths as IconDefs, size, fill, style, weight);
}

export function IconSpeaker({ fill, size = 12, style, weight = 'regular' }: MobileIconProps) {
  return renderPhosphorIcon(SpeakerHighPaths as IconDefs, size, fill, style, weight);
}

export function IconStar({ fill, size = 18, style, weight = 'regular' }: MobileIconProps) {
  return renderPhosphorIcon(StarPaths as IconDefs, size, fill, style, weight);
}

export function IconStop({ fill, size = 12, style, weight = 'regular' }: MobileIconProps) {
  return renderPhosphorIcon(StopCirclePaths as IconDefs, size, fill, style, weight);
}

export function IconSun({ fill, size = 18, style, weight = 'regular' }: MobileIconProps) {
  return renderPhosphorIcon(SunDimPaths as IconDefs, size, fill, style, weight);
}

export function IconTrash({ fill, size = 18, style, weight = 'regular' }: MobileIconProps) {
  return renderPhosphorIcon(TrashPaths as IconDefs, size, fill, style, weight);
}

export function IconPencil({ fill, size = 18, style, weight = 'regular' }: MobileIconProps) {
  return renderPhosphorIcon(PencilSimplePaths as IconDefs, size, fill, style, weight);
}

export function getModelOption(modelId: string): ModelOption | null {
  return AVAILABLE_MODELS.find((model) => model.id === modelId) ?? null;
}

export function readStoredMobileModel() {
  if (typeof window === 'undefined') return DEFAULT_MOBILE_CHAT_MODEL;
  try {
    const stored = window.localStorage.getItem(MOBILE_CHAT_MODEL_STORAGE_KEY);
    return stored && getModelOption(stored) ? stored : DEFAULT_MOBILE_CHAT_MODEL;
  } catch {
    return DEFAULT_MOBILE_CHAT_MODEL;
  }
}

export function getMobilePalette(themeId: string): MobilePalette {
  if (themeId === 'dark') {
    return {
      isDark: true,
      rootBackground: '#111111',
      rootText: '#f8fafc',
      mutedText: 'rgba(226, 232, 240, 0.78)',
      subduedText: 'rgba(148, 163, 184, 0.82)',
      sidebarBackground: 'rgba(15, 15, 18, 0.82)',
      overlayBackground: 'rgba(0, 0, 0, 0.52)',
      panelBackground: 'rgba(20, 20, 24, 0.58)',
      panelElevated: 'linear-gradient(180deg, rgba(42, 42, 48, 0.74) 0%, rgba(14, 14, 18, 0.9) 100%)',
      cardBackground: 'rgba(255, 255, 255, 0.06)',
      cardBorder: 'rgba(255, 255, 255, 0.1)',
      menuBackground: 'rgba(23, 23, 28, 0.94)',
      accent: '#8fb4ff',
      accentSoft: 'rgba(143, 180, 255, 0.14)',
      accentBorder: 'rgba(143, 180, 255, 0.22)',
      success: '#34d399',
      successSoft: 'rgba(52, 211, 153, 0.16)',
      successBorder: 'rgba(52, 211, 153, 0.24)',
      danger: '#fb7185',
      dangerSoft: 'rgba(251, 113, 133, 0.16)',
      dangerBorder: 'rgba(251, 113, 133, 0.24)',
      warning: '#f59e0b',
      warningSoft: 'rgba(245, 158, 11, 0.16)',
      inputBackground: 'rgba(14, 14, 18, 0.62)',
      inputBorder: 'rgba(255, 255, 255, 0.12)',
      composerBackground: 'rgba(10, 10, 12, 0.72)',
      userBubble: 'rgba(42, 42, 48, 0.86)',
      iconFill: '#ffffff',
      inverseIconFill: '#1a1a2e',
      shadow: '0 26px 60px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
    };
  }

  return {
    isDark: false,
    rootBackground: '#f5f0eb',
    rootText: '#1a1a2e',
    mutedText: 'rgba(26, 26, 46, 0.78)',
    subduedText: 'rgba(71, 85, 105, 0.82)',
    sidebarBackground: 'rgba(255, 249, 243, 0.86)',
    overlayBackground: 'rgba(20, 31, 57, 0.14)',
    panelBackground: 'rgba(255, 255, 255, 0.58)',
    panelElevated: 'linear-gradient(180deg, rgba(255, 255, 255, 0.84) 0%, rgba(245, 240, 235, 0.68) 100%)',
    cardBackground: 'rgba(255, 255, 255, 0.56)',
    cardBorder: 'rgba(37, 99, 235, 0.12)',
    menuBackground: 'rgba(255, 249, 243, 0.96)',
    accent: '#2563eb',
    accentSoft: 'rgba(37, 99, 235, 0.12)',
    accentBorder: 'rgba(37, 99, 235, 0.18)',
    success: '#16a34a',
    successSoft: 'rgba(22, 163, 74, 0.12)',
    successBorder: 'rgba(22, 163, 74, 0.16)',
    danger: '#dc2626',
    dangerSoft: 'rgba(220, 38, 38, 0.1)',
    dangerBorder: 'rgba(220, 38, 38, 0.16)',
    warning: '#f97316',
    warningSoft: 'rgba(249, 115, 22, 0.12)',
    inputBackground: 'rgba(255, 255, 255, 0.78)',
    inputBorder: 'rgba(37, 99, 235, 0.12)',
    composerBackground: 'rgba(250, 245, 239, 0.82)',
    userBubble: 'rgba(37, 99, 235, 0.12)',
    iconFill: '#1a1a2e',
    inverseIconFill: '#ffffff',
    shadow: '0 28px 72px rgba(37, 99, 235, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.7)',
  };
}

export function glassButtonStyle(
  size: number,
  tint: 'neutral' | 'teal' | 'rose' | 'orange' | 'accent',
  active: boolean,
  palette: MobilePalette,
): CSSProperties {
  const darkGradients: Record<string, string> = {
    neutral: 'linear-gradient(135deg, rgba(148, 163, 184, 0.32) 0%, rgba(17, 24, 39, 0.92) 56%, rgba(148, 163, 184, 0.18) 100%)',
    teal: 'linear-gradient(135deg, rgba(45, 212, 191, 0.24) 0%, rgba(17, 24, 39, 0.9) 54%, rgba(45, 212, 191, 0.12) 100%)',
    rose: 'linear-gradient(135deg, rgba(244, 114, 182, 0.26) 0%, rgba(17, 24, 39, 0.9) 54%, rgba(244, 114, 182, 0.12) 100%)',
    orange: 'linear-gradient(135deg, rgba(245, 158, 11, 0.28) 0%, rgba(17, 24, 39, 0.9) 54%, rgba(245, 158, 11, 0.12) 100%)',
    accent: 'linear-gradient(135deg, rgba(143, 180, 255, 0.28) 0%, rgba(17, 24, 39, 0.92) 56%, rgba(143, 180, 255, 0.14) 100%)',
  };
  const lightGradients: Record<string, string> = {
    neutral: 'linear-gradient(135deg, rgba(255, 255, 255, 0.82) 0%, rgba(245, 240, 235, 0.7) 100%)',
    teal: 'linear-gradient(135deg, rgba(96, 165, 250, 0.18) 0%, rgba(255, 255, 255, 0.84) 58%, rgba(37, 99, 235, 0.1) 100%)',
    rose: 'linear-gradient(135deg, rgba(251, 113, 133, 0.14) 0%, rgba(255, 255, 255, 0.84) 58%, rgba(251, 113, 133, 0.08) 100%)',
    orange: 'linear-gradient(135deg, rgba(249, 115, 22, 0.16) 0%, rgba(255, 255, 255, 0.84) 58%, rgba(249, 115, 22, 0.08) 100%)',
    accent: 'linear-gradient(135deg, rgba(37, 99, 235, 0.18) 0%, rgba(255, 255, 255, 0.88) 58%, rgba(37, 99, 235, 0.1) 100%)',
  };

  const borderColor = palette.isDark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(37, 99, 235, 0.14)';
  const background = palette.isDark ? darkGradients[tint] : lightGradients[tint];

  return {
    width: size,
    height: size,
    borderRadius: size / 2,
    border: `1px solid ${borderColor}`,
    background: active ? background : palette.cardBackground,
    boxShadow: active ? palette.shadow : 'none',
    cursor: active ? 'pointer' : 'default',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    opacity: active ? 1 : 0.45,
    transition: 'all 0.22s ease',
  };
}

export function isGovernanceApproval(approval: ApprovalItem): boolean {
  if (approval.continuation?.kind === 'lane') return true;
  if (approval.risk === 'high') return true;
  if (approval.source === 'test') return false;
  if (approval.continuation?.kind === 'llm-chat') return false;
  if (approval.continuation?.kind === 'runtime') return false;
  if (approval.source === 'llm-chat') return false;
  if (approval.source === 'runtime') return false;
  return false;
}

export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

export function generateChatTabId(): string {
  if (typeof window !== 'undefined' && typeof window.crypto?.randomUUID === 'function') {
    return `mobile-chat-${window.crypto.randomUUID()}`;
  }
  return `mobile-chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function extractMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('\n')
      .trim();
  }
  if (content && typeof content === 'object' && 'text' in content && typeof content.text === 'string') {
    return content.text;
  }
  return '';
}

export function normalizeChatMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return [];

  return messages.reduce<ChatMessage[]>((acc, message) => {
    if (!message || typeof message !== 'object') return acc;
    const role = 'role' in message ? message.role : undefined;
    if (role !== 'user' && role !== 'assistant') return acc;
    const content = extractMessageContent('content' in message ? message.content : '');
    acc.push({ role, content });
    return acc;
  }, []);
}

export function getConversationTitle(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  return truncateText(firstUserMessage?.content ?? 'Untitled conversation', CHAT_TITLE_MAX_LENGTH);
}

export function normalizeHistoryList(data: unknown): ChatHistoryRecord[] {
  if (!data || typeof data !== 'object') return [];

  const items = 'items' in data && Array.isArray(data.items)
    ? data.items
    : ('conversations' in data && Array.isArray(data.conversations) ? data.conversations : []);

  return items
    .reduce<ChatHistoryRecord[]>((acc, item) => {
      if (!item || typeof item !== 'object') return acc;
      const tabId = 'tabId' in item && typeof item.tabId === 'string' ? item.tabId : '';
      if (!tabId) return acc;
      const title = 'title' in item && typeof item.title === 'string' && item.title.trim()
        ? item.title
        : 'Untitled conversation';
      const lastMessage = 'lastMessage' in item && typeof item.lastMessage === 'string'
        ? item.lastMessage
        : ('preview' in item && typeof item.preview === 'string' ? item.preview : '');
      const updatedAt = 'updatedAt' in item && typeof item.updatedAt === 'string'
        ? item.updatedAt
        : ('modifiedAt' in item && typeof item.modifiedAt === 'string' ? item.modifiedAt : '');
      const model = 'model' in item && typeof item.model === 'string' ? item.model : undefined;
      const starred = 'starred' in item && item.starred === true;

      acc.push({ tabId, title, lastMessage, updatedAt, model, starred });
      return acc;
    }, [])
    .slice(0, MAX_RECENT_CONVERSATIONS);
}

export function mobileCardStyle(palette: MobilePalette, extra?: CSSProperties): CSSProperties {
  return {
    background: palette.panelElevated,
    border: `1px solid ${palette.cardBorder}`,
    boxShadow: palette.shadow,
    borderRadius: 22,
    ...extra,
  };
}

export function sectionLabelStyle(palette: MobilePalette): CSSProperties {
  return {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: palette.subduedText,
  };
}

export function mobileFontFamily() {
  return 'ui-rounded, "SF Pro Rounded", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
}

export function renderConnectionLabel(status: 'connected' | 'disconnected') {
  return status === 'connected' ? 'Connected' : 'Disconnected';
}

export function formatAboutVersion(version: string) {
  return version.trim() || '0.1.0';
}
