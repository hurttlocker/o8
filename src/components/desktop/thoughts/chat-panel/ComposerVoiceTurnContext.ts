'use client';

import { createContext } from 'react';

export interface ComposerVoiceTurnTarget {
  dictationId: string;
  /** Intercept the existing composer's delivery without registering another mic owner. */
  intercept: (handler: (text: string) => boolean) => () => void;
}

export const ComposerVoiceTurnContext = createContext<ComposerVoiceTurnTarget | null>(null);
