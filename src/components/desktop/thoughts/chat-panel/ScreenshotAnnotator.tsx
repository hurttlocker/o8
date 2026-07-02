'use client';

/**
 * ScreenshotAnnotator — a lightweight canvas markup editor for composer image
 * attachments. Attach a screenshot → click it → draw arrow / box / pen /
 * highlight, or drop TEXT CARDS → Done composites everything onto the image and
 * hands back a data URI that REPLACES the attachment, so it flows to the agent
 * unchanged (the data URI is the wire format end-to-end). Arrowhead math from the
 * agent point-overlay (head 15, spread π/7). (2026-07-02)
 *
 * Text is a persistent, visible, draggable CARD you click into and type — not an
 * inline canvas input. WKWebView only grants real keyboard focus on a genuine
 * click into a field (programmatic .focus() sets activeElement but not OS text
 * focus), and it refuses keyboard input entirely to a field nested inside a
 * backdrop-filter element. The card sidesteps both: you click it (real gesture),
 * it never auto-dismisses, and the blur scrim is a sibling layer, not an ancestor.
 *
 * House rules: inline styles only, var(--t-*) tokens, raw <svg> icons, no emoji.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ThoughtsAttachedImage } from './useThoughtsComposerAttachments';

type Tool = 'arrow' | 'box' | 'pen' | 'highlight' | 'text';

type Shape =
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { kind: 'box'; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { kind: 'highlight'; x1: number; y1: number; x2: number; y2: number; color: string }
  | { kind: 'pen'; points: Array<{ x: number; y: number }>; color: string; width: number };

interface TextCard { id: number; x: number; y: number; value: string; color: string }

const COLORS = ['#FF5A1F', '#EF4444', '#3B82F6', '#22C55E', '#111827', '#FFFFFF'];
const MAX_DATA_URI = 5_000_000; // ws-server hard cap (ws-server.ts:2814) — silent drop above this

function drawShape(ctx: CanvasRenderingContext2D, s: Shape) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.kind === 'box') {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.strokeRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
  } else if (s.kind === 'arrow') {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.stroke();
    const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    const head = Math.max(12, s.width * 4);
    const spread = Math.PI / 7;
    ctx.beginPath();
    ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - head * Math.cos(ang - spread), s.y2 - head * Math.sin(ang - spread));
    ctx.lineTo(s.x2 - head * Math.cos(ang + spread), s.y2 - head * Math.sin(ang + spread));
    ctx.closePath();
    ctx.fill();
  } else if (s.kind === 'highlight') {
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = s.color;
    ctx.fillRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
  } else {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
  }
  ctx.restore();
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Rasterize a text card onto the canvas at Done — a white rounded box with a
// colored border and the typed text, anchored at the card's natural (x, y).
function drawTextCard(ctx: CanvasRenderingContext2D, card: TextCard, naturalW: number) {
  const text = card.value.replace(/\s+$/, '');
  if (!text.trim()) return;
  const fontSize = Math.max(20, Math.round(naturalW / 46));
  ctx.save();
  ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'top';
  const lines = text.split('\n');
  const pad = Math.round(fontSize * 0.55);
  const lineH = Math.round(fontSize * 1.32);
  let textW = 1;
  for (const l of lines) textW = Math.max(textW, ctx.measureText(l || ' ').width);
  const boxW = Math.round(textW + pad * 2);
  const boxH = Math.round(lines.length * lineH + pad * 2);
  const r = Math.round(fontSize * 0.35);
  roundRectPath(ctx, card.x, card.y, boxW, boxH, r);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
  ctx.fill();
  ctx.lineWidth = Math.max(2, Math.round(fontSize / 9));
  ctx.strokeStyle = card.color;
  roundRectPath(ctx, card.x, card.y, boxW, boxH, r);
  ctx.stroke();
  ctx.fillStyle = '#161616';
  lines.forEach((line, i) => ctx.fillText(line, card.x + pad, card.y + pad + i * lineH));
  ctx.restore();
}

export function ScreenshotAnnotator({
  image,
  onCancel,
  onDone,
}: {
  image: ThoughtsAttachedImage;
  onCancel: () => void;
  onDone: (nextDataUri: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const shapesRef = useRef<Shape[]>([]);
  const draftRef = useRef<Shape | null>(null);
  const drawingRef = useRef(false);
  const strokeWRef = useRef(4);
  const cardIdRef = useRef(1);

  const [ready, setReady] = useState(false);
  const [dims, setDims] = useState({ w: 1, h: 1 });
  const [tool, setTool] = useState<Tool>('arrow');
  const [color, setColor] = useState(COLORS[0]);
  const [shapeCount, setShapeCount] = useState(0);
  const [textCards, setTextCards] = useState<TextCard[]>([]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const s of shapesRef.current) drawShape(ctx, s);
    if (draftRef.current) drawShape(ctx, draftRef.current);
  }, []);

  // Load the image at natural resolution.
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      strokeWRef.current = Math.max(3, Math.round(img.naturalWidth / 350));
      setDims({ w: img.naturalWidth, h: img.naturalHeight });
      setReady(true);
      redraw();
    };
    img.src = image.dataUri;
  }, [image.dataUri, redraw]);

  useEffect(() => { redraw(); }, [redraw, ready, shapeCount]);

  // Escape cancels the editor. Textareas stopPropagation, so Esc while typing
  // blurs the field instead of closing the whole annotator.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // Hide the native browser view while the editor is open — it's a native OS
  // window that paints ABOVE this DOM overlay and would occlude the canvas.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('o8:native-browser-occlude', { detail: { occlude: true } }));
    return () => {
      window.dispatchEvent(new CustomEvent('o8:native-browser-occlude', { detail: { occlude: false } }));
    };
  }, []);

  const clientToNatural = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (canvas.width / Math.max(1, rect.width)),
      y: (clientY - rect.top) * (canvas.height / Math.max(1, rect.height)),
    };
  }, []);

  const handleDown = (e: ReactPointerEvent) => {
    const { x, y } = clientToNatural(e.clientX, e.clientY);
    if (tool === 'text') {
      const id = cardIdRef.current;
      cardIdRef.current += 1;
      setTextCards((cur) => [...cur, { id, x, y, value: '', color }]);
      return;
    }
    drawingRef.current = true;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const w = strokeWRef.current;
    if (tool === 'pen') {
      draftRef.current = { kind: 'pen', points: [{ x, y }], color, width: w };
    } else if (tool === 'highlight') {
      draftRef.current = { kind: 'highlight', x1: x, y1: y, x2: x, y2: y, color };
    } else if (tool === 'arrow') {
      draftRef.current = { kind: 'arrow', x1: x, y1: y, x2: x, y2: y, color, width: w };
    } else {
      draftRef.current = { kind: 'box', x1: x, y1: y, x2: x, y2: y, color, width: w };
    }
    redraw();
  };

  const handleMove = (e: ReactPointerEvent) => {
    if (!drawingRef.current || !draftRef.current) return;
    const { x, y } = clientToNatural(e.clientX, e.clientY);
    const d = draftRef.current;
    if (d.kind === 'pen') d.points.push({ x, y });
    else { d.x2 = x; d.y2 = y; }
    redraw();
  };

  const handleUp = () => {
    if (!drawingRef.current || !draftRef.current) return;
    drawingRef.current = false;
    shapesRef.current = [...shapesRef.current, draftRef.current];
    draftRef.current = null;
    setShapeCount((c) => c + 1);
  };

  const undo = () => {
    if (shapesRef.current.length === 0) return;
    shapesRef.current = shapesRef.current.slice(0, -1);
    setShapeCount((c) => Math.max(0, c - 1));
  };

  const done = () => {
    const canvas = canvasRef.current;
    if (!canvas) { onCancel(); return; }
    const ctx = canvas.getContext('2d');
    if (ctx) {
      redraw(); // image + shapes
      for (const card of textCards) drawTextCard(ctx, card, canvas.width);
    }
    let uri = canvas.toDataURL('image/png');
    if (uri.length >= MAX_DATA_URI) {
      for (const q of [0.92, 0.8, 0.65, 0.5]) {
        uri = canvas.toDataURL('image/jpeg', q);
        if (uri.length < MAX_DATA_URI) break;
      }
    }
    onDone(uri);
  };

  const overlay = (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        paddingTop: 20,
        paddingRight: 20,
        paddingBottom: 20,
        paddingLeft: 20,
      }}
    >
      {/* Blur scrim on its OWN layer, BEHIND the content — NOT an ancestor of any
          text field (WKWebView blocks keyboard input inside backdrop-filter). */}
      <div
        aria-hidden
        onPointerDown={onCancel}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: -1,
          background: 'rgba(20, 16, 12, 0.62)',
          backdropFilter: 'blur(18px)',
          WebkitBackdropFilter: 'blur(18px)',
        } as CSSProperties}
      />
      <Toolbar
        tool={tool}
        onTool={setTool}
        color={color}
        onColor={setColor}
        canUndo={shapeCount > 0}
        onUndo={undo}
        onDone={done}
        onCancel={onCancel}
      />

      <div style={{ position: 'relative', maxWidth: '100%', minHeight: 0, display: 'flex' }}>
        <canvas
          ref={canvasRef}
          onPointerDown={handleDown}
          onPointerMove={handleMove}
          onPointerUp={handleUp}
          onPointerLeave={handleUp}
          style={{
            display: 'block',
            maxWidth: '86vw',
            maxHeight: '74vh',
            width: 'auto',
            height: 'auto',
            borderRadius: 12,
            boxShadow: '0 24px 70px rgba(0, 0, 0, 0.5)',
            cursor: tool === 'text' ? 'text' : 'crosshair',
            touchAction: 'none',
          }}
        />
        {textCards.map((card) => (
          <TextCardView
            key={card.id}
            card={card}
            dims={dims}
            clientToNatural={clientToNatural}
            onChange={(value) => setTextCards((cur) => cur.map((c) => (c.id === card.id ? { ...c, value } : c)))}
            onMove={(x, y) => setTextCards((cur) => cur.map((c) => (c.id === card.id ? { ...c, x, y } : c)))}
            onDelete={() => setTextCards((cur) => cur.filter((c) => c.id !== card.id))}
          />
        ))}
      </div>

      <div style={{ fontSize: 11.5, fontWeight: 400, color: 'rgba(255,255,255,0.72)', fontFamily: 'var(--font-sans-system)', letterSpacing: '-0.01em' }}>
        Pick a tool and draw · Text drops a card — click it and type · drag its bar to move · Done attaches it
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(overlay, document.body);
}

// ── Text card (persistent, visible, click-to-type, draggable) ──────────────

function TextCardView({
  card, dims, clientToNatural, onChange, onMove, onDelete,
}: {
  card: TextCard;
  dims: { w: number; h: number };
  clientToNatural: (x: number, y: number) => { x: number; y: number };
  onChange: (value: string) => void;
  onMove: (x: number, y: number) => void;
  onDelete: () => void;
}) {
  const grabOffset = useRef({ dx: 0, dy: 0 });
  const [dragging, setDragging] = useState(false);

  const leftPct = dims.w ? (card.x / dims.w) * 100 : 0;
  const topPct = dims.h ? (card.y / dims.h) * 100 : 0;

  const onHandleDown = (e: ReactPointerEvent) => {
    e.stopPropagation();
    const nat = clientToNatural(e.clientX, e.clientY);
    grabOffset.current = { dx: nat.x - card.x, dy: nat.y - card.y };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setDragging(true);
  };
  const onHandleMove = (e: ReactPointerEvent) => {
    if (!dragging) return;
    e.stopPropagation();
    const nat = clientToNatural(e.clientX, e.clientY);
    onMove(nat.x - grabOffset.current.dx, nat.y - grabOffset.current.dy);
  };
  const onHandleUp = (e: ReactPointerEvent) => {
    if (!dragging) return;
    e.stopPropagation();
    setDragging(false);
  };

  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left: `${leftPct}%`,
        top: `${topPct}%`,
        zIndex: 3,
        minWidth: 104,
        maxWidth: 280,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 9,
        borderWidth: 2,
        borderStyle: 'solid',
        borderColor: card.color,
        background: 'rgba(255, 255, 255, 0.98)',
        boxShadow: '0 8px 26px rgba(0, 0, 0, 0.32)',
        overflow: 'hidden',
      }}
    >
      <div
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
          paddingTop: 3,
          paddingBottom: 3,
          paddingLeft: 7,
          paddingRight: 4,
          background: card.color,
          cursor: dragging ? 'grabbing' : 'grab',
          touchAction: 'none',
        }}
      >
        <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth={2.4} strokeLinecap="round" aria-hidden="true">
          <path d="M7 8h10M7 12h10M7 16h10" />
        </svg>
        <button
          type="button"
          aria-label="Delete text"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onDelete}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 16,
            height: 16,
            borderRadius: 999,
            borderWidth: 0,
            background: 'rgba(255,255,255,0.28)',
            color: '#fff',
            cursor: 'pointer',
            padding: 0,
            flexShrink: 0,
          }}
        >
          <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <textarea
        autoFocus
        value={card.value}
        onChange={(e) => onChange(e.target.value)}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur(); }}
        onKeyUp={(e) => e.stopPropagation()}
        placeholder="Type here"
        rows={1}
        style={{
          resize: 'none',
          borderWidth: 0,
          outline: 'none',
          paddingTop: 7,
          paddingBottom: 7,
          paddingLeft: 9,
          paddingRight: 9,
          fontSize: 14,
          fontWeight: 600,
          lineHeight: 1.35,
          fontFamily: 'var(--font-sans-system)',
          color: '#161616',
          background: 'transparent',
          minHeight: 34,
          width: '100%',
          boxSizing: 'border-box',
        }}
      />
    </div>
  );
}

// ── Toolbar ────────────────────────────────────────────────────────────────

function Toolbar({
  tool, onTool, color, onColor, canUndo, onUndo, onDone, onCancel,
}: {
  tool: Tool;
  onTool: (t: Tool) => void;
  color: string;
  onColor: (c: string) => void;
  canUndo: boolean;
  onUndo: () => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingTop: 8,
        paddingBottom: 8,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 14,
        background: 'var(--t-input-bg)',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider)',
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35)',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      {(['arrow', 'box', 'pen', 'highlight', 'text'] as Tool[]).map((t) => (
        <ToolButton key={t} active={tool === t} onClick={() => onTool(t)} label={t}>
          <ToolIcon tool={t} />
        </ToolButton>
      ))}

      <div style={{ width: 1, height: 22, background: 'var(--t-divider)', marginLeft: 2, marginRight: 2 }} />

      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`Color ${c}`}
          onClick={() => onColor(c)}
          style={{
            width: 20,
            height: 20,
            borderRadius: 999,
            background: c,
            borderWidth: color === c ? 2 : 1,
            borderStyle: 'solid',
            borderColor: color === c ? 'var(--t-text)' : 'var(--t-divider)',
            cursor: 'pointer',
            padding: 0,
            flexShrink: 0,
          }}
        />
      ))}

      <div style={{ width: 1, height: 22, background: 'var(--t-divider)', marginLeft: 2, marginRight: 2 }} />

      <ToolButton active={false} onClick={onUndo} label="Undo" disabled={!canUndo}>
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 14 4 9l5-5" />
          <path d="M4 9h11a5 5 0 0 1 0 10h-4" />
        </svg>
      </ToolButton>

      <button
        type="button"
        onClick={onCancel}
        style={{
          height: 30,
          paddingLeft: 12,
          paddingRight: 12,
          borderRadius: 8,
          borderWidth: 0,
          background: 'transparent',
          color: 'var(--t-text-muted)',
          fontSize: 12.5,
          fontWeight: 400,
          cursor: 'pointer',
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onDone}
        style={{
          height: 30,
          paddingLeft: 14,
          paddingRight: 14,
          borderRadius: 8,
          borderWidth: 0,
          background: 'var(--t-text)',
          color: 'var(--t-bg-card)',
          fontSize: 12.5,
          fontWeight: 500,
          cursor: 'pointer',
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        Done
      </button>
    </div>
  );
}

function ToolButton({ active, disabled, onClick, label, children }: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 30,
        height: 30,
        borderRadius: 8,
        borderWidth: 0,
        background: active ? 'var(--t-panel-active, var(--t-hover))' : 'transparent',
        color: disabled ? 'var(--t-text-faint)' : active ? 'var(--t-text)' : 'var(--t-text-muted)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 120ms ease, color 120ms ease',
        padding: 0,
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

function ToolIcon({ tool }: { tool: Tool }) {
  const common = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (tool === 'arrow') return (<svg {...common}><path d="M7 17 17 7" /><path d="M8 7h9v9" /></svg>);
  if (tool === 'box') return (<svg {...common}><rect x="4" y="5" width="16" height="14" rx="2" /></svg>);
  if (tool === 'pen') return (<svg {...common}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>);
  if (tool === 'highlight') return (<svg {...common}><path d="m9 11-6 6v3h3l6-6" /><path d="m14 5 5 5" /><path d="M13 6 18 1l5 5-5 5Z" /></svg>);
  return (<svg {...common}><path d="M4 7V5h16v2" /><path d="M9 19h6" /><path d="M12 5v14" /></svg>);
}
