/**
 * Infinite-canvas geometry. Widgets keep their 1-4 column/row span hints, but live at absolute
 * world-pixel positions so the human can drag them anywhere and the agent can read where they are.
 */
export const COL = 300;
export const ROW = 150;
export const GAP = 16;
/** Columns used when auto-placing new widgets and by "Tidy up". */
export const PACK_COLS = 4;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const spanPx = (span: number, unit: number): number => span * unit + (span - 1) * GAP;
export const sizeOf = (w: { w: number; h: number }): { width: number; height: number } => ({ width: spanPx(w.w, COL), height: spanPx(w.h, ROW) });

export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
}

export function contains(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** First free grid slot (scanning rows, then columns) for a widget of span w x h. */
export function findSlot(span: { w: number; h: number }, taken: Rect[], cols = PACK_COLS): { x: number; y: number } {
  const { width, height } = sizeOf(span);
  const fitCols = Math.max(cols, span.w);
  for (let row = 0; row < 10_000; row++) {
    for (let col = 0; col + span.w <= fitCols; col++) {
      const r = { x: col * (COL + GAP), y: row * (ROW + GAP), width, height };
      if (!taken.some((t) => overlaps(r, t))) return { x: r.x, y: r.y };
    }
  }
  return { x: 0, y: Math.max(0, ...taken.map((t) => t.y + t.height + GAP)) };
}

/** "Tidy up": re-pack widgets densely, keeping their reading order (top-to-bottom, left-to-right). */
export function tidy<T extends { id: string; x: number; y: number; w: number; h: number }>(items: T[], cols = PACK_COLS): Map<string, { x: number; y: number }> {
  const order = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: Rect[] = [];
  const out = new Map<string, { x: number; y: number }>();
  for (const it of order) {
    const p = findSlot(it, placed, cols);
    placed.push({ ...p, ...sizeOf(it) });
    out.set(it.id, p);
  }
  return out;
}

/**
 * After an agent resizes a widget, push anything it now covers straight down (cascading),
 * so agent-driven layout never leaves cards stacked on top of each other.
 */
export function pushDown<T extends { id: string; x: number; y: number; w: number; h: number }>(fixedId: string, items: T[]): Map<string, number> {
  const rects = new Map(items.map((i) => [i.id, { x: i.x, y: i.y, ...sizeOf(i) }]));
  const moved = new Map<string, number>();
  const queue = [fixedId];
  let guard = 0;
  while (queue.length && guard++ < 10_000) {
    const id = queue.shift() as string;
    const a = rects.get(id) as Rect;
    const hits = [...rects.entries()].filter(([oid, r]) => oid !== id && r.y >= a.y - 1 && overlaps(a, r)).sort((p, q) => p[1].y - q[1].y);
    for (const [oid, r] of hits) {
      r.y = a.y + a.height + GAP;
      moved.set(oid, r.y);
      queue.push(oid);
    }
  }
  return moved;
}
