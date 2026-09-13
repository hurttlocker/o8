'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { readStoredOrchestratorModel } from '@/lib/orchestrator/store';

export function useOrchestratorModelState(input: {
  operatorDefaultModel: string;
  repoPath: string | null;
}) {
  const { operatorDefaultModel, repoPath } = input;
  const [model, setModel] = useState(operatorDefaultModel);
  const sourceRef = useRef<'default' | 'stored' | 'user'>('default');
  const repoPathRef = useRef<string | null | undefined>(undefined);

  const acceptModel = useCallback((nextModel: string) => {
    sourceRef.current = 'user';
    setModel(nextModel);
  }, []);
  const restoreModel = useCallback((storedModel: string) => {
    sourceRef.current = 'stored';
    setModel(storedModel);
  }, []);

  useEffect(() => {
    if (repoPathRef.current !== repoPath) {
      repoPathRef.current = repoPath;
      const storedModel = readStoredOrchestratorModel(repoPath);
      sourceRef.current = storedModel ? 'stored' : 'default';
      // Persisted repo state is an external source that must be synchronized after render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setModel(storedModel ?? operatorDefaultModel);
      return;
    }
    if (sourceRef.current === 'default') {
      // Operator-default refreshes apply only until a stored or user choice takes ownership.
      setModel(operatorDefaultModel);
    }
  }, [operatorDefaultModel, repoPath]);

  return { acceptModel, model, restoreModel, setModel };
}
