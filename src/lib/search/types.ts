export type SearchKind =
  | 'issue'
  | 'file'
  | 'agent'
  | 'chat'
  | 'transcript'
  | 'approval'
  | 'inbox'
  | 'directive';

export interface SearchTarget {
  issueNumber?: number;
  repo?: string;
  filePath?: string;
  line?: number;
  sessionKey?: string;
  chatTabId?: string;
  chatRepoName?: string;
  chatRepoPath?: string;
  chatRepoBranch?: string;
  chatRemoteUrl?: string;
  packetId?: string;
  laneId?: string;
  approvalId?: string;
  inboxItemId?: string;
  openInbox?: boolean;
  directiveId?: string;
}

export interface SearchResult {
  kind: SearchKind;
  id: string;
  title: string;
  detail: string;
  target?: SearchTarget;
  score: number;
}

export type SearchGroups = Record<SearchKind, SearchResult[]>;

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  groups: SearchGroups;
  timings?: Partial<Record<SearchKind, number>>;
  providerErrors?: Partial<Record<SearchKind, string>>;
  error?: string;
}

export function emptySearchGroups(): SearchGroups {
  return {
    issue: [],
    file: [],
    agent: [],
    chat: [],
    transcript: [],
    approval: [],
    inbox: [],
    directive: [],
  };
}
