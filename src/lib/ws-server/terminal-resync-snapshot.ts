export interface TmuxSnapshotCursor {
  x: number;
  y: number;
  cols: number;
  rows: number;
}

export function parseTmuxSnapshotCursor(value: string): TmuxSnapshotCursor | null {
  const parts = value.trim().split(/\s+/u).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isSafeInteger(part))) return null;
  const [x, y, cols, rows] = parts;
  if (cols < 1 || rows < 1 || x < 0 || x >= cols || y < 0 || y >= rows) return null;
  return { x, y, cols, rows };
}

export function formatTmuxResyncSnapshot(
  data: string,
  cursor: TmuxSnapshotCursor | null | undefined,
  dimensions: { cols: number; rows: number },
): string {
  // capture-pane separates display rows with LF. Live PTY writes use CRLF,
  // so replay must begin every captured row at column zero.
  const rows = data.replace(/\r?\n$/u, '').replace(/\r?\n/gu, '\r\n');
  if (!cursor || cursor.cols !== dimensions.cols || cursor.rows !== dimensions.rows) return rows;
  // capture-pane includes blank screen rows. Without this final cursor move,
  // the prompt can appear at the top while typed echo lands at the bottom.
  return `${rows}\x1b[${cursor.y + 1};${cursor.x + 1}H`;
}
