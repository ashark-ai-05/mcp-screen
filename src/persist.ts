/**
 * Canvas persistence: the canvas (widgets, their positions, annotations) survives a hub restart.
 * Saved to <home>/canvas.json (mode 0600, atomic rename), debounced after every change.
 * On load every widget goes back through the normal validation path (`place`), so a hand-edited or stale
 * file can't smuggle in anything the tools would reject; live sources still need the allow-list.
 * Not saved: open questions/forms (their tool call is gone), MCP App frames (their upstream session is gone).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ScreenApi } from './api.js';
import type { CanvasStore } from './store.js';
import type { Annotation, Widget } from './types.js';

export const CANVAS_FILE = 'canvas.json';
const VERSION = 1;

interface Snapshot {
  version: number;
  savedAt: string;
  widgets: Widget[];
  annotations: Annotation[];
}

const keep = (w: Widget): boolean => w.kind !== 'mcp-app' && !((w.kind === 'question' || w.kind === 'form') && w.data.state === 'open');

/** The raw inputs a widget was placed with: derived fields added by enrich() are rebuilt on load. */
function rawData(w: Widget): Record<string, unknown> {
  const d = { ...w.data };
  if (w.kind === 'diff') { delete d.files; delete d.added; delete d.removed; }
  if (w.kind === 'diagram') { delete d.graph; delete d.layout; }
  if (w.kind === 'checklist') delete d.progress;
  if (w.kind === 'log') delete d.dropped;
  return d;
}

export function snapshot(store: CanvasStore): Snapshot {
  return { version: VERSION, savedAt: new Date().toISOString(), widgets: store.list().filter(keep), annotations: store.listAnnotations() };
}

export function startPersistence(home: string, store: CanvasStore, delayMs = 300): { flush(): void; stop(): void } {
  const file = path.join(home, CANVAS_FILE);
  let timer: NodeJS.Timeout | null = null;
  const write = (): void => {
    timer = null;
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot(store)), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      /* best effort: a read-only home just means no persistence */
    }
  };
  const off = store.bus.on((e) => {
    // activity/report events don't change the canvas
    if (e.type === 'activity' || e.type === 'report') return;
    if (!timer) timer = setTimeout(write, delayMs);
  });
  return {
    flush: () => { if (timer) { clearTimeout(timer); write(); } },
    stop: () => { off(); if (timer) { clearTimeout(timer); write(); } },
  };
}

/** Restore a saved canvas. Returns how many widgets and annotations came back, and how many were skipped. */
export async function restore(home: string, store: CanvasStore, api: ScreenApi): Promise<{ widgets: number; annotations: number; skipped: number }> {
  const out = { widgets: 0, annotations: 0, skipped: 0 };
  let snap: Snapshot;
  try {
    snap = JSON.parse(fs.readFileSync(path.join(home, CANVAS_FILE), 'utf8')) as Snapshot;
  } catch {
    return out;
  }
  if (!snap || snap.version !== VERSION || !Array.isArray(snap.widgets)) return out;
  for (const w of snap.widgets.slice(0, 1000)) {
    try {
      if (!w || typeof w !== 'object' || !keep(w)) throw new Error('skip');
      await api.place({ id: w.id, kind: w.kind, title: w.title, data: rawData(w), w: w.w, h: w.h, x: w.x, y: w.y, ...(w.source ? { source: w.source, intervalMs: w.intervalMs } : {}) } as never);
      out.widgets++;
    } catch {
      out.skipped++;
    }
  }
  for (const a of (Array.isArray(snap.annotations) ? snap.annotations : []).slice(0, 2000)) {
    try {
      const back = store.annotate({ kind: a.kind, points: a.points, text: a.text, color: a.color, dataPoints: a.target?.dataPoints, scroll: a.target?.scroll, widgetId: a.target?.widgetId });
      for (const r of Array.isArray(a.replies) ? a.replies : []) if (r && typeof r.text === 'string') store.replyAnnotation(back.id, r.text, r.from === 'human' ? 'human' : 'agent');
      out.annotations++;
    } catch {
      out.skipped++;
    }
  }
  return out;
}
