type CanvasRenderProbe = (id: string) => void;

let probe: CanvasRenderProbe | null = null;

export function setCanvasRenderProbe(next: CanvasRenderProbe | null): CanvasRenderProbe | null {
  const previous = probe;
  probe = next;
  return previous;
}

export function useCanvasRenderProbe(kind: string, id: number): void {
  probe?.(`${kind}:${id}`);
}
