export interface SemanticFact {
  id: string;
  label: string;
  value: string;
}

export interface SemanticEvent {
  id: string;
  timestamp: string;
  actor: string;
  verb: string;
}

export type SemanticBlock =
  | {
      kind: 'facts';
      id: string;
      title: string;
      facts: readonly SemanticFact[];
    }
  | {
      kind: 'event-log';
      id: string;
      title: string;
      events: readonly SemanticEvent[];
    };

export interface SemanticSurface {
  id: string;
  blocks: readonly SemanticBlock[];
}
