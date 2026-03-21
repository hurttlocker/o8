/**
 * Skeleton Map — Type definitions.
 *
 * Aider-style repo map: AST signatures compressed for LLM context injection.
 */

export type SupportedLanguage = 'typescript' | 'tsx' | 'rust' | 'json' | 'markdown';

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'method'
  | 'property'
  | 'heading';

/** A single extracted symbol from a source file. */
export interface SkeletonSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  /** The declaration line, trimmed of body. Max 200 chars. */
  signature: string;
  exported: boolean;
  /** Parent class/interface name if this is a nested method/property. */
  parent?: string;
}

/** Parsed skeleton for a single file. */
export interface FileSkeleton {
  relativePath: string;
  language: SupportedLanguage;
  symbols: SkeletonSymbol[];
  imports: string[];
  lineCount: number;
  /** SHA-256 hex digest of file content. */
  contentHash: string;
}

/** The complete map for a repository. */
export interface SkeletonMap {
  repoPath: string;
  repoName: string;
  files: FileSkeleton[];
  totalFiles: number;
  totalSymbols: number;
  totalLines: number;
  generatedAt: string;
  scanDurationMs: number;
}

/** Compact rendered output for LLM injection. */
export interface RenderedSkeleton {
  text: string;
  /** Rough token count (chars / 4). */
  tokenEstimate: number;
  fileCount: number;
  symbolCount: number;
}

// ── Chunking types (AST-aware code chunks for embedding) ──

/** A structural code chunk — one complete function, class, or type. */
export interface CodeChunk {
  /** Unique within a file: "functionName" or "ClassName.methodName" */
  symbolName: string;
  symbolKind: SymbolKind;
  /** Full source text of this chunk. */
  body: string;
  startLine: number;
  endLine: number;
  /** Byte offsets in the original file. */
  startPos: number;
  endPos: number;
  /** Estimated token count (chars / 4). */
  tokenCount: number;
  exported: boolean;
  /** Parent symbol (e.g. class name for a method chunk). */
  parent?: string;
  /** Import paths referenced in this chunk's scope. */
  localImports: string[];
}

/** All chunks extracted from a single file. */
export interface FileChunks {
  relativePath: string;
  language: SupportedLanguage;
  chunks: CodeChunk[];
  contentHash: string;
  totalTokens: number;
}

/** Shape of a row in the skeleton_chunks SQLite table. */
export interface ChunkCacheRow {
  repo_path: string;
  file_path: string;
  symbol_name: string;
  symbol_kind: string;
  body: string;
  start_line: number;
  end_line: number;
  start_pos: number;
  end_pos: number;
  token_count: number;
  exported: number;
  parent: string | null;
  imports_json: string;
  content_hash: string;
  parsed_at: string;
}

/** Options for scanning a repository. */
export interface ScanOptions {
  repoPath: string;
  /** Max files to process (default 2000). */
  maxFiles?: number;
  /** Max file size in bytes (default 200KB). Skip larger files. */
  maxFileSize?: number;
  /** Include test files (default false). */
  includeTests?: boolean;
  /** Enable AST-aware chunking (default true). */
  chunks?: boolean;
}

/** Options for rendering the skeleton text. */
export interface RenderOptions {
  /** Target token budget (default 5000). */
  maxTokens?: number;
  /** Prioritize symbols from these paths (3x weight). */
  focusPaths?: string[];
  /** Include import lines (default false). */
  includeImports?: boolean;
  /** Grouping mode (default 'directory'). */
  groupBy?: 'directory' | 'flat';
}

/** Shape of a row in the skeleton_cache SQLite table. */
export interface SkeletonCacheRow {
  repo_path: string;
  file_path: string;
  content_hash: string;
  language: string;
  symbols_json: string;
  imports_json: string;
  line_count: number;
  parsed_at: string;
}
