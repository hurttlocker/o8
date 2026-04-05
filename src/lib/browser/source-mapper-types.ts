export interface PickedElement {
  targetUrl?: string;
  pageTitle?: string;
  selector?: string;
  tagName: string;
  id?: string | null;
  classes?: string[];
  role?: string | null;
  name?: string | null;
  text?: string;
  snippet?: string;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  styles?: Record<string, string>;
  textContent?: string;
  classList?: string[];
  parentChain?: string[];
  attributes?: Record<string, string | null | undefined>;
  componentNames?: string[];
}

export interface SourceMatch {
  file: string;
  line: number;
  column: number;
  component: string;
  confidence: number;
  matchReason: 'text_content' | 'class_name' | 'component_name' | 'tag_structure' | 'attribute';
}

export type MatchReason = SourceMatch['matchReason'];
export type SearchMode = 'fixed' | 'regex';

export interface SearchDescriptor {
  mode: SearchMode;
  query: string;
  baseConfidence: number;
  reason: MatchReason;
  component?: string;
  textLength: number;
}
