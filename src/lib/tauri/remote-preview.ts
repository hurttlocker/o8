import { invoke } from '@tauri-apps/api/core';
import type { BrowserViewRect } from './bridge';

// Do not pass a general browser initialization script or use browser-view.
// Errors propagate so an older or unsupported native shell is visible to users.
export const remotePreviewSupported = () => invoke<boolean>('remote_preview_supported');
export const remotePreviewOpen = (id: string, url: string, rect: BrowserViewRect) => invoke<void>('remote_preview_open', { id, url, ...rect });
export const remotePreviewSetRect = (id: string, rect: BrowserViewRect, visible: boolean) => invoke<void>('remote_preview_set_rect', { id, ...rect, visible });
export const remotePreviewClose = (id: string) => invoke<void>('remote_preview_close', { id });
