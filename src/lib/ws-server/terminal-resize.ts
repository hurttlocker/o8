type ResizableTerminalAttachment = {
  cols: number;
  rows: number;
  ptyProcess: { resize: (cols: number, rows: number) => void };
};

export function resizeTerminalIfChanged(
  attachment: ResizableTerminalAttachment,
  cols: number,
  rows: number,
): boolean {
  if (cols === attachment.cols && rows === attachment.rows) return false;
  attachment.ptyProcess.resize(cols, rows);
  attachment.cols = cols;
  attachment.rows = rows;
  return true;
}
