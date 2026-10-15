import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { startHub, type Hub } from '../src/hub.js';
import { COL, findSlot, GAP, overlaps, pushDown, ROW, sizeOf, tidy } from '../src/layout.js';
import { createScreenServer } from '../src/mcp.js';
import { CanvasStore } from '../src/store.js';

const md = (s: CanvasStore, id: string, extra: Record<string, unknown> = {}) => s.place({ id, kind: 'markdown', title: id, data: { markdown: id }, ...extra });

describe('infinite canvas: layout maths', () => {
  it('sizes spans in pixels and finds the first free slot', () => {
    expect(sizeOf({ w: 2, h: 1 })).toEqual({ width: 2 * COL + GAP, height: ROW });
    expect(findSlot({ w: 1, h: 1 }, [])).toEqual({ x: 0, y: 0 });
    const taken = [{ x: 0, y: 0, ...sizeOf({ w: 3, h: 1 }) }];
    expect(findSlot({ w: 1, h: 1 }, taken)).toEqual({ x: 3 * (COL + GAP), y: 0 });
    expect(findSlot({ w: 2, h: 1 }, taken)).toEqual({ x: 0, y: ROW + GAP });
  });

  it('tidy packs densely in reading order and never overlaps', () => {
    const items = [
      { id: 'a', x: 900, y: 900, w: 2, h: 2 },
      { id: 'b', x: 10, y: 10, w: 4, h: 1 },
      { id: 'c', x: 500, y: 400, w: 1, h: 1 },
      { id: 'd', x: 3000, y: 3000, w: 2, h: 1 },
    ];
    const out = tidy(items);
    expect(out.get('b')).toEqual({ x: 0, y: 0 });
    const rects = items.map((i) => ({ ...(out.get(i.id) as { x: number; y: number }), ...sizeOf(i) }));
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
    expect(Math.max(...rects.map((r) => r.y + r.height))).toBeLessThan(4 * (ROW + GAP));
  });

  it('pushDown moves covered widgets below a grown one, cascading', () => {
    const items = [
      { id: 'big', x: 0, y: 0, w: 2, h: 3 },
      { id: 'under', x: 0, y: ROW + GAP, w: 1, h: 1 },
      { id: 'under2', x: 0, y: 2 * (ROW + GAP), w: 1, h: 1 },
      { id: 'beside', x: 2 * (COL + GAP), y: 0, w: 1, h: 1 },
    ];
    const moved = pushDown('big', items);
    expect(moved.has('beside')).toBe(false);
    expect(moved.get('under')).toBe(sizeOf({ w: 2, h: 3 }).height + GAP);
    expect(moved.get('under2')!).toBeGreaterThan(moved.get('under')!);
  });
});

describe('infinite canvas: store', () => {
  it('auto-places new widgets without overlap and honours explicit x/y', () => {
    const s = new CanvasStore();
    const a = md(s, 'a', { w: 4, h: 1 });
    const b = md(s, 'b');
    expect([a.x, a.y]).toEqual([0, 0]);
    expect(b.y).toBe(ROW + GAP);
    const c = md(s, 'c', { x: 2000.4, y: -300 });
    expect([c.x, c.y]).toEqual([2000, -300]);
  });

  it('moves, tidies, and pushes down on agent resize', () => {
    const s = new CanvasStore();
    md(s, 'a');
    md(s, 'b');
    s.move('b', 5000, 5000);
    expect(s.get('b')).toMatchObject({ x: 5000, y: 5000 });
    s.tidy();
    expect(s.get('b')).toMatchObject({ x: COL + GAP, y: 0 });
    md(s, 'c', { x: 0, y: 2 * ROW + 2 * GAP });
    s.update('a', { h: 4 });
    const a = s.read('a');
    expect(s.get('c')!.y).toBeGreaterThanOrEqual(a.y + a.height);
  });

  it('read_canvas exposes positions and pixel sizes', () => {
    const s = new CanvasStore();
    md(s, 'a', { w: 2, h: 1 });
    expect(s.readCanvas().widgets[0]).toMatchObject({ id: 'a', x: 0, y: 0, width: 2 * COL + GAP, height: ROW });
  });
});

describe('infinite canvas: HTTP + MCP', () => {
  let hub: Hub | undefined;
  afterEach(async () => hub?.close());
  it('POST /move persists, /tidy re-packs, and tools expose it', async () => {
    hub = await startHub({ port: 0, home: null });
    const post = (p: string, body: unknown) =>
      fetch(`${hub!.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcp-screen-token': hub!.token }, body: JSON.stringify(body) });
    md(hub.store, 'a');
    expect((await post('/api/widgets/a/move', { x: 777, y: 123 })).status).toBe(200);
    expect(hub.store.get('a')).toMatchObject({ x: 777, y: 123 });
    expect((await post('/api/widgets/a/move', { x: 'no' })).status).toBe(400);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createScreenServer(hub.api).connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(ct);
    const tidied = JSON.parse(((await client.callTool({ name: 'tidy_canvas', arguments: {} })).content as { text: string }[])[0]!.text);
    expect(tidied.positions).toEqual([{ id: 'a', x: 0, y: 0 }]);
    await client.callTool({ name: 'update_widget', arguments: { id: 'a', x: 40, y: 50 } });
    const canvas = JSON.parse(((await client.callTool({ name: 'read_canvas', arguments: {} })).content as { text: string }[])[0]!.text);
    expect(canvas.widgets[0]).toMatchObject({ x: 40, y: 50 });
    expect(canvas.annotations).toEqual([]);
    await client.close();
  });
});
