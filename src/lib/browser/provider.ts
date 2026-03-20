import type {
  BrowserAttachmentSummary,
  BrowserProviderId,
  BrowserSurfaceSummary,
} from '@/lib/browser/types';

export interface BrowserProvider {
  id: BrowserProviderId;
  displayName: string;
  discoverSurfaces(): Promise<BrowserSurfaceSummary[]>;
  attachSurface?(surfaceId: string): Promise<BrowserAttachmentSummary>;
}
