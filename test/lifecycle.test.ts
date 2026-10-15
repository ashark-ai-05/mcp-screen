import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteApi } from '../src/api.js';
import { EventBus, MAX_QUEUE } from '../src/bus.js';
import { startHub, type Hub } from '../src/hub.js';
import { callScreenTool } from '../src/mcp.js';
import { CanvasStore } from '../src/store.js';

type Boxy = { x: number; y: number; w?: number; h?: number; width?: number; height?: number };
const noOverlap = (ws: Boxy[]) => {
  const box = (w: Boxy) => ({ x0: w.x, y0: w.y, x1: w.x + (w.width ?? w.w! * 300 + (w.w! - 1) * 16), y1: w.y + (w.height ?? w.h! * 150 + (w.h! - 1) * 16) });
  return ws.every((a, i) => ws.every((b, j) => {
    if (j <= i) return true;
    const p = box(a), q = box(b);
    return p.x1 <= q.x0 || q.x1 <= p.x0 || p.y1 <= q.y0 || q.y1 <= p.y0;
  }));
};
type Canvas = { widgets: Array<Boxy & { id: string }> };
const canvasOf = async (api: RemoteApi): Promise<Canvas> => (await api.readCanvas()) as unknown as Canvas;
const spec = (i: number) => ({ id: `w${i}`, kind: 'chart' as const, title: `w${i}`, data: { labels: ['a', 'b'], values: [i, 1] }, w: 1 + (i % 2), h: 1 + (i % 3 === 0 ? 1 : 0) });

describe('clear + reuse lifecycle', () => {
  it('survives 60 cycles of place → annotate → clear → undo → clear → place again', () => {
    const s = new CanvasStore();
    for (let cycle = 0; cycle < 60; cycle++) {
      for (let i = 0; i < 8; i++) s.place(spec(i));
      const w0 = s.get('w0')!;
      s.annotate({ kind: 'circle', points: [[w0.x + 10, w0.y + 10], [w0.x + 60, w0.y + 60]], text: `c${cycle}` });
      expect(s.list()).toHaveLength(8);
      expect(noOverlap(s.list())).toBe(true);
      expect(s.clear().removed).toBe(8);
      expect(s.list()).toHaveLength(0);
      expect(s.listAnnotations()).toHaveLength(0);
      expect(s.undoClear()).toHaveLength(8);
      expect(s.listAnnotations()).toHaveLength(1);
      expect(s.listAnnotations()[0]!.target?.widgetId).toBe('w0');
      s.clear();
    }
    // after all that, ids are reusable, positions start fresh, nothing leaked
    s.place(spec(0));
    expect(s.get('w0')).toMatchObject({ x: 0, y: 0 });
    expect(s.listAnnotations()).toHaveLength(0);
  });

  it('undo after a second clear brings back only the latest set; undo twice is a no-op', () => {
    const s = new CanvasStore();
    s.place(spec(1));
    s.clear();
    s.place(spec(2));
    s.clear();
    expect(s.undoClear().map((w) => w.id)).toEqual(['w2']);
    expect(s.undoClear()).toHaveLength(0);
    expect(s.list().map((w) => w.id)).toEqual(['w2']);
  });

  it('placing over ids that undo restores replaces them instead of duplicating', () => {
    const s = new CanvasStore();
    s.place(spec(1));
    s.clear();
    s.place({ ...spec(1), title: 'new' });
    s.undoClear();
    const all = s.list();
    expect(all.filter((w) => w.id === 'w1')).toHaveLength(1);
    expect(noOverlap(all)).toBe(true);
  });

  it('long session: 3000 place/update/remove + 600 annotations leave nothing behind', () => {
    const s = new CanvasStore();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 3000; i++) {
      const id = `t${i % 40}`;
      const lines = Array.from({ length: 50 }, (_, k) => `line ${k} of ${i}`);
      if (s.get(id)) s.update(id, { data: { lines }, merge: false } as never);
      else s.place({ id, kind: 'log', title: id, data: { lines } });
      s.update(id, { data: { append: ['more'] } } as never);
      if (i % 5 === 0) {
        const w = s.get(id)!;
        s.annotate({ kind: 'note', points: [[w.x + 5, w.y + 5]], text: 'n' });
      }
      if (i % 3 === 0) s.remove(id);
    }
    s.clear();
    s.clear(); // drops the undo snapshot of the previous clear
    expect(s.list()).toHaveLength(0);
    expect(s.listAnnotations()).toHaveLength(0);
    global.gc?.();
    const grown = (process.memoryUsage().heapUsed - before) / 1e6;
    expect(grown).toBeLessThan(60);
  });

  it('a stuck SSE subscriber is dropped instead of buffering forever', () => {
    const bus = new EventBus();
    const sub = bus.subscribe();
    for (let i = 0; i < MAX_QUEUE + 10; i++) bus.push({ type: 'removed', id: `x${i}` } as never);
    expect(bus.subscriberCount()).toBe(0);
    sub.close();
  });
});

describe('sessions and restarts', () => {
  let hub: Hub | null = null;
  afterEach(async () => { await hub?.close(); hub = null; });

  it('several agent sessions placing at once never overlap and all see one canvas', async () => {
    hub = await startHub({ port: 0, home: null });
    const sessions = Array.from({ length: 4 }, () => new RemoteApi(hub!.url, hub!.token));
    await Promise.all(sessions.flatMap((api, k) => Array.from({ length: 6 }, (_, i) => api.place({ ...spec(k * 10 + i), id: `s${k}-${i}` }))));
    const canvases = await Promise.all(sessions.map((api) => canvasOf(api)));
    for (const c of canvases) expect(c.widgets).toHaveLength(24);
    expect(noOverlap(canvases[0]!.widgets)).toBe(true);
    // one session clears, another undoes, a third places again
    await sessions[0]!.clear();
    expect((await canvasOf(sessions[1]!)).widgets).toHaveLength(0);
    await sessions[1]!.undoClear();
    expect((await canvasOf(sessions[2]!)).widgets).toHaveLength(24);
    await sessions[2]!.clear();
    await sessions[3]!.place(spec(1));
    expect((await canvasOf(sessions[0]!)).widgets.map((w) => w.id)).toEqual(['w1']);
  });

  it('a hub restart on the same home comes back clean and usable', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-screen-restart-'));
    for (let round = 0; round < 3; round++) {
      hub = await startHub({ port: 0, home });
      const api = new RemoteApi(hub.url, hub.token);
      const c = await canvasOf(api);
      expect(c.widgets).toHaveLength(0); // canvas state is in memory only (documented)
      await api.place(spec(round));
      await api.clear();
      await api.undoClear();
      expect((await canvasOf(api)).widgets).toHaveLength(1);
      await hub.close();
      hub = null;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// ---------- fuzz: random garbage into every tool must give a tool result, never a crash ----------
function rng(seed: number) {
  return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
}
function garbage(r: () => number, depth = 0): unknown {
  const pick = Math.floor(r() * 12);
  const strs = ['', 'x', '__proto__', 'constructor', '../../etc/passwd', '<img src=x onerror=alert(1)>', 'ꙮ'.repeat(50), '\u0000', 'a'.repeat(5000), 'javascript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>', '1e309'];
  switch (pick) {
    case 0: return null;
    case 1: return undefined;
    case 2: return r() < 0.5;
    case 3: return [NaN, Infinity, -1, 0, 1e12, -1e12, 3.7, 2 ** 53][Math.floor(r() * 8)];
    case 4: case 5: return strs[Math.floor(r() * strs.length)];
    case 6: case 7: return depth > 3 ? [] : Array.from({ length: Math.floor(r() * 4) }, () => garbage(r, depth + 1));
    default: {
      if (depth > 3) return {};
      const keys = ['id', 'kind', 'title', 'data', 'w', 'h', 'x', 'y', 'source', 'intervalMs', 'labels', 'values', 'items', 'mermaid', 'before', 'after', 'patch', 'path', 'url', 'markers', 'lines', 'append', 'set', 'fields', 'prompt', 'question', 'choices', 'code', 'columns', 'rows', 'timeoutSeconds', 'undo', '__proto__'];
      const o: Record<string, unknown> = {};
      for (let i = 0; i < 1 + Math.floor(r() * 5); i++) o[keys[Math.floor(r() * keys.length)]!] = garbage(r, depth + 1);
      return o;
    }
  }
}
const KINDS = ['markdown', 'text', 'table', 'chart', 'metric', 'kv', 'status-list', 'livemap', 'code', 'diff', 'diagram', 'image', 'log', 'checklist', 'map', 'timeline', 'form', 'nope'];
const TOOLS = ['place_widget', 'update_widget', 'read_widget', 'read_canvas', 'remove_widget', 'clear_canvas', 'tidy_canvas', 'post_report', 'ask_user', 'ask_form'];

describe('fuzz', () => {
  let hub: Hub | null = null;
  afterEach(async () => { await hub?.close(); hub = null; });

  it('2000 random tool calls: every one returns a result, the hub stays healthy, the canvas stays consistent', async () => {
    hub = await startHub({ port: 0, home: null });
    const api = new RemoteApi(hub.url, hub.token);
    const r = rng(42);
    let errors = 0;
    for (let i = 0; i < 2000; i++) {
      const tool = TOOLS[Math.floor(r() * TOOLS.length)]!;
      let args = garbage(r) as Record<string, unknown>;
      // half the place calls use a real kind so validation goes deeper than the first check
      if (tool === 'place_widget' && r() < 0.6) args = { ...(typeof args === 'object' && args ? args : {}), kind: KINDS[Math.floor(r() * KINDS.length)], title: 'f' };
      if ((tool === 'update_widget' || tool === 'read_widget' || tool === 'remove_widget') && r() < 0.5) args = { ...(typeof args === 'object' && args ? args : {}), id: `f${Math.floor(r() * 5)}` };
      if (tool === 'ask_user' || tool === 'ask_form') args = { ...(typeof args === 'object' && args ? args : {}), timeoutSeconds: 0.01 };
      const res = await callScreenTool(api, tool, args);
      expect(res).not.toBeNull();
      expect(Array.isArray(res!.content)).toBe(true);
      if (res!.isError) errors++;
    }
    expect(errors).toBeGreaterThan(100); // most garbage is rejected…
    const c = await canvasOf(api);
    expect(noOverlap(c.widgets)).toBe(true); // …and what got through is laid out sanely
    for (const w of c.widgets) expect(Number.isFinite(w.x) && Number.isFinite(w.y) && w.x >= 0 && w.y >= 0).toBe(true);
    expect(JSON.stringify({}.constructor.prototype)).toBe('{}'); // no prototype pollution
    // still fully usable
    await api.clear();
    await api.place(spec(1));
    expect((await canvasOf(api)).widgets).toHaveLength(1);
    const res = await fetch(`${hub.url}/`);
    expect(res.status).toBe(200);
  }, 120_000);
});
