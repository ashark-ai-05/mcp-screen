import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CanvasBook, defaultCanvasFrom, slug } from '../src/canvases.js';
import { startHub, type Hub } from '../src/hub.js';
import { RemoteApi } from '../src/api.js';
import { callScreenTool } from '../src/mcp.js';

describe('named canvases', () => {
  it('slugs and defaults from git root / env', () => {
    expect(slug('My App!!')).toBe('my-app');
    const prev = process.env.MCP_SCREEN_CANVAS;
    process.env.MCP_SCREEN_CANVAS = 'Acme Checkout';
    expect(defaultCanvasFrom()).toEqual({ id: 'acme-checkout', title: 'Acme Checkout' });
    if (prev === undefined) delete process.env.MCP_SCREEN_CANVAS; else process.env.MCP_SCREEN_CANVAS = prev;
  });

  it('keeps separate stores and switches the active one', () => {
    const book = new CanvasBook({ home: null, persist: false, seed: { id: 'alpha', title: 'Alpha' } });
    book.store('alpha').place({ id: 'a', kind: 'metric', title: 'A', data: { value: 1 } });
    book.ensure('beta', 'Beta').store.place({ id: 'b', kind: 'metric', title: 'B', data: { value: 2 } });
    expect(book.active.list().map((w) => w.id)).toEqual(['a']);
    book.setActive('beta');
    expect(book.active.list().map((w) => w.id)).toEqual(['b']);
    expect(book.list().map((c) => c.id).sort()).toEqual(['alpha', 'beta']);
  });

  let hub: Hub | undefined;
  let home: string | undefined;
  afterEach(async () => { await hub?.close(); if (home) fs.rmSync(home, { recursive: true, force: true }); });

  it('persists each canvas under canvases/ and migrates legacy canvas.json', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cv-'));
    fs.writeFileSync(path.join(home, 'canvas.json'), JSON.stringify({
      version: 1, savedAt: new Date().toISOString(),
      widgets: [{ id: 'legacy', kind: 'metric', title: 'Legacy', data: { value: 7 }, w: 1, h: 1, x: 0, y: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
      annotations: [],
    }));
    hub = await startHub({ port: 0, home, canvas: 'legacy-proj' });
    expect(hub.store.list().map((w) => w.id)).toEqual(['legacy']);
    expect(fs.existsSync(path.join(home, 'canvases', 'legacy-proj.json'))).toBe(true);

    await hub.api.openCanvas('other', 'Other');
    await hub.api.place({ id: 'x', kind: 'metric', title: 'X', data: { value: 3 } });
    hub.book.flush();
    expect(fs.existsSync(path.join(home, 'canvases', 'other.json'))).toBe(true);

    await hub.close(); hub = undefined;
    hub = await startHub({ port: 0, home, canvas: 'legacy-proj' });
    expect(hub.book.list().map((c) => c.id).sort()).toEqual(['legacy-proj', 'other']);
    hub.book.setActive('other');
    expect(hub.store.list().map((w) => w.id)).toEqual(['x']);
  });

  it('list_canvases / open_canvas / place with canvas work through MCP', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cv-'));
    hub = await startHub({ port: 0, home, canvas: 'main' });
    const remote = new RemoteApi(hub.url, hub.token);
    const listed = JSON.parse(((await callScreenTool(remote, 'list_canvases', {}))!.content[0] as { text: string }).text);
    expect(listed.some((c: { id: string }) => c.id === 'main')).toBe(true);
    await callScreenTool(remote, 'open_canvas', { id: 'shop', title: 'Shop' });
    await callScreenTool(remote, 'place_widget', { kind: 'metric', title: 'Orders', data: { value: 9 }, canvas: 'shop' });
    expect(hub.book.activeCanvasId).toBe('shop');
    expect(hub.store.list().map((w) => w.title)).toEqual(['Orders']);
    const canvas = JSON.parse(((await callScreenTool(remote, 'read_canvas', { canvas: 'shop' }))!.content[0] as { text: string }).text);
    expect(canvas.canvas).toBe('shop');
    expect(canvas.canvases.length).toBeGreaterThanOrEqual(2);
  });
});
