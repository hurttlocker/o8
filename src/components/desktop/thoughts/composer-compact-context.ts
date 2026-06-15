'use client';

import { createContext, useContext } from 'react';

/**
 * "The composer button row is too narrow for labels." The InputButtons row
 * measures its own width (ResizeObserver) and flips this to true below a
 * threshold; chips rendered inside it — the model picker and the ModeChip
 * agent picker handed in via composerLeadingExtras — drop their text labels to
 * icon-only, matching the below-composer chip row's adaptive behavior so both
 * collapse in lockstep as the panel narrows. Context (not prop-threading) so
 * the opaque leading-extras node can opt in without changing the composer API.
 *
 * Default false: any chip rendered outside the composer row keeps its label.
 */
export const ComposerChipCompactContext = createContext(false);

export function useComposerChipCompact(): boolean {
  return useContext(ComposerChipCompactContext);
}
